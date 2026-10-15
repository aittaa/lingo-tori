import { describe, expect, it, vi } from "vitest"
import { providerConfigSchemaList } from "@/types/config/provider"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { LLM_MODEL_OPTIONS } from "@/utils/constants/models"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getConfigWithoutCredentials, hasAPIKey } from "../api"
import { LATEST_SCHEMA_VERSION } from "../migration"

type Loose = Record<string, any>

function redactProvider(provider: Loose): Loose {
  const result = getConfigWithoutCredentials({ providersConfig: [provider] })
  return result.providersConfig[0]!
}

function redactUrl(url: string): string {
  return redactProvider({ baseURL: url }).baseURL
}

function redactOptions(providerOptions: Loose): Loose {
  return redactProvider({ providerOptions }).providerOptions
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys))
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

describe("getConfigWithoutCredentials", () => {
  describe("provider properties", () => {
    it("drops apiKey and every headers object, whatever the header is called", () => {
      const result = redactProvider({
        id: "p",
        apiKey: "FAKE-KEY",
        headers: {
          Authorization: "Bearer FAKE",
          authorization: "Bearer FAKE",
          "x-api-key": "FAKE",
          "X-Gateway-Pass": "FAKE",
        },
      })

      expect(result).toEqual({ id: "p" })
    })

    it("keeps providers with nothing to drop exactly as they are", () => {
      const provider = {
        id: "p",
        name: "P",
        enabled: true,
        provider: "openai",
        temperature: 0.2,
        model: { model: "gpt", isCustomModel: false, customModel: null },
      }

      expect(redactProvider(provider)).toEqual(provider)
    })

    it("cleans providers nested in arrays and maps at any depth", () => {
      const result = getConfigWithoutCredentials({
        providersConfig: [[{ id: "a", headers: { Authorization: "FAKE" }, apiKey: "FAKE" }]],
        other: { providersConfig: { b: { apiKey: "FAKE", baseURL: "https://u:p@h.example/v1" } } },
      })

      expect(result).toEqual({
        providersConfig: [[{ id: "a" }]],
        other: { providersConfig: { b: { baseURL: "https://h.example/v1" } } },
      })
    })

    it("cleans the map shape older stored configs used", () => {
      const result = getConfigWithoutCredentials({
        providersConfig: {
          openai: { apiKey: "FAKE", baseURL: "https://api.example/v1?api_key=FAKE" },
          deeplx: { apiKey: "FAKE", baseURL: "https://api.deeplx.org/{{apiKey}}/translate" },
        },
      })

      expect(result).toEqual({
        providersConfig: {
          openai: { baseURL: "https://api.example/v1?api_key=" },
          deeplx: { baseURL: "https://api.deeplx.org/{{apiKey}}/translate" },
        },
      })
    })

    it("still drops a property named apiKey wherever it sits", () => {
      const result = getConfigWithoutCredentials({
        a: { apiKey: "FAKE", keep: 1, list: [{ apiKey: "FAKE", keep: 2 }] },
      })

      expect(result).toEqual({ a: { keep: 1, list: [{ keep: 2 }] } })
      expect(hasAPIKey(result)).toBe(false)
    })
  })

  describe("URLs in provider settings", () => {
    it.each([
      [
        "a user and a password",
        "https://user:pass@host.example.com/v1",
        "https://host.example.com/v1",
      ],
      [
        "only a user, which can be the key",
        "https://FAKE@host.example.com/v1",
        "https://host.example.com/v1",
      ],
      [
        "a password that holds an @",
        "https://user:p@ss@host.example.com/v1",
        "https://host.example.com/v1",
      ],
      ["a scheme-relative URL", "//user:pass@host.example.com/v1", "//host.example.com/v1"],
      [
        "a literal user beside the placeholder",
        "https://user:{{apiKey}}@host.example.com/v1",
        "https://host.example.com/v1",
      ],
    ])("removes userinfo: %s", (_name, input, expected) => {
      expect(redactUrl(input)).toBe(expected)
    })

    it.each([
      ["the placeholder alone as userinfo", "https://{{apiKey}}@host.example.com/v1"],
      ["an @ after the host", "https://host.example.com/v1/@user"],
      ["an @ in the query", "https://host.example.com/v1?email=a@b.example"],
      ["no userinfo", "https://host.example.com/v1"],
    ])("leaves a URL with %s as it is", (_name, input) => {
      expect(redactUrl(input)).toBe(input)
    })

    it.each([
      ["key", "https://h.example/v1?key=FAKE", "https://h.example/v1?key="],
      ["api_key", "https://h.example/v1?api_key=FAKE", "https://h.example/v1?api_key="],
      ["apiKey", "https://h.example/v1?apiKey=FAKE", "https://h.example/v1?apiKey="],
      ["token", "https://h.example/v1?token=FAKE", "https://h.example/v1?token="],
      [
        "a mixed-case name",
        "https://h.example/v1?API_KEY=A&Token=B&Access_Token=C",
        "https://h.example/v1?API_KEY=&Token=&Access_Token=",
      ],
      [
        "a percent-encoded name",
        "https://h.example/v1?api%5Fkey=FAKE",
        "https://h.example/v1?api%5Fkey=",
      ],
      [
        "a percent-encoded letter in the name",
        "https://h.example/v1?to%6Ben=FAKE",
        "https://h.example/v1?to%6Ben=",
      ],
      [
        "a name with a dash",
        "https://h.example/v1?subscription-key=FAKE",
        "https://h.example/v1?subscription-key=",
      ],
      [
        "a signature",
        "https://h.example/blob?sig=FAKE&se=2030",
        "https://h.example/blob?sig=&se=2030",
      ],
      [
        "a value with an equals sign",
        "https://h.example/v1?token=a=b=c",
        "https://h.example/v1?token=",
      ],
      ["a repeated name", "https://h.example/v1?key=A&key=B", "https://h.example/v1?key=&key="],
      [
        "the fragment",
        "https://h.example/v1#access_token=FAKE&state=s",
        "https://h.example/v1#access_token=&state=s",
      ],
      [
        "a query and a fragment",
        "https://h.example/v1?key=A#token=B",
        "https://h.example/v1?key=#token=",
      ],
    ])("redacts the value of a secret query parameter: %s", (_name, input, expected) => {
      expect(redactUrl(input)).toBe(expected)
    })

    it.each([
      ["a value that is only the placeholder", "https://h.example/v1?key={{apiKey}}"],
      ["parameters that are not secret", "https://h.example/v1?model=lingo&region=eu"],
      ["a secret name without a value", "https://h.example/v1?key"],
      ["a secret name with an empty value", "https://h.example/v1?key="],
      ["a fragment that is not parameters", "https://h.example/v1#section"],
      ["the placeholder in the path", "https://api.deeplx.org/{{apiKey}}/translate"],
      ["a value that is not a URL", "localhost:11434"],
      ["an empty value", ""],
    ])("leaves %s as it is", (_name, input) => {
      expect(redactUrl(input)).toBe(input)
    })

    it("keeps a placeholder that sits beside a literal parameter, and redacts only the literal", () => {
      expect(redactUrl("https://h.example/v1?key={{apiKey}}&token=FAKE")).toBe(
        "https://h.example/v1?key={{apiKey}}&token=",
      )
    })

    it("treats the open-responses url field the same way", () => {
      expect(redactProvider({ url: "https://u:p@h.example/v1/responses?key=FAKE" }).url).toBe(
        "https://h.example/v1/responses?key=",
      )
    })

    /**
     * A literal key in the path is indistinguishable from a path segment. The export does not guess,
     * so this is the one place a key typed straight into a URL can still travel; the test records
     * that limit rather than hiding it.
     */
    it("known limit: a literal key in the URL path is not detected", () => {
      const url = "https://api.deeplx.org/FAKE-LITERAL-KEY/translate"

      expect(redactUrl(url)).toBe(url)
    })

    it("does not rewrite URLs outside provider settings", () => {
      const config = { siteRules: { url: "https://u:p@h.example/?key=FAKE" } }

      expect(getConfigWithoutCredentials(config)).toEqual(config)
    })
  })

  describe("providerOptions", () => {
    it.each([
      "apiKey",
      "api_key",
      "API_KEY",
      "x-api-key",
      "X-Api-Key",
      "xApiKey",
      "apikey",
      "accessKey",
      "secretAccessKey",
      "client_secret",
      "clientSecret",
      "token",
      "accessToken",
      "access_token",
      "refresh_token",
      "bearer",
      "Authorization",
      "authorization",
      "auth",
      "basicAuth",
      "oauth",
      "password",
      "credentials",
      "Cookie",
      "headers",
      "extra_headers",
      "extraHeaders",
      "defaultHeaders",
      "sig",
      "signature",
      "jwt",
      "key",
      "subscriptionKey",
      // Over-redaction on purpose: a cache key is not a credential, but the name cannot tell.
      "promptCacheKey",
    ])("drops an entry named %s", (name) => {
      expect(redactOptions({ keep: 1, [name]: "FAKE" })).toEqual({ keep: 1 })
    })

    it.each([
      "reasoningEffort",
      "reasoning_effort",
      "budgetTokens",
      "budget_tokens",
      "maxTokens",
      "max_completion_tokens",
      "maxOutputTokens",
      "thinking",
      "thinkingConfig",
      "chat_template_kwargs",
      "enableThinking",
      "temperature",
      "top_p",
      "top_k",
      "keep_alive",
      "author",
      "tokenizer",
      "keyboard",
    ])("keeps an entry named %s", (name) => {
      const options = { [name]: "value" }

      expect(redactOptions(options)).toEqual(options)
    })

    it("drops entries at any depth and leaves the rest of the branch alone", () => {
      expect(
        redactOptions({
          thinking: { type: "enabled", budgetTokens: 1024 },
          routing: { order: ["a", "b"], deep: [{ ok: true, client_secret: "FAKE" }] },
          extra_headers: { Authorization: "FAKE" },
        }),
      ).toEqual({
        thinking: { type: "enabled", budgetTokens: 1024 },
        routing: { order: ["a", "b"], deep: [{ ok: true }] },
      })
    })
  })

  describe("what it must not touch", () => {
    it("returns the default config unchanged", () => {
      expect(getConfigWithoutCredentials(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    })

    it("returns every default provider unchanged", () => {
      const providers = Object.values(DEFAULT_PROVIDER_CONFIG)

      expect(getConfigWithoutCredentials({ providersConfig: providers })).toEqual({
        providersConfig: providers,
      })
    })

    it("does not rename a shortcut's key outside provider settings", () => {
      const config = { translationHub: { shortcut: { key: "Alt+T" } }, providersConfig: [] }

      expect(getConfigWithoutCredentials(config)).toEqual(config)
    })

    it("does not change the object it was given, even a frozen one", () => {
      const config = deepFreeze({
        providersConfig: [
          {
            id: "p",
            apiKey: "FAKE",
            baseURL: "https://u:p@h.example/v1?key=FAKE",
            headers: { Authorization: "FAKE" },
            providerOptions: { token: "FAKE", keep: { x: 1 } },
          },
        ],
      })
      const before = structuredClone(config)

      const result = getConfigWithoutCredentials(config)

      expect(config).toEqual(before)
      expect(result).not.toBe(config)
      expect(result.providersConfig[0]).not.toBe(config.providersConfig[0])
    })

    it("returns a copy, so editing the result cannot reach the original", () => {
      const config = { providersConfig: [{ id: "p", providerOptions: { keep: { x: 1 } } }] }

      const result = getConfigWithoutCredentials(config)
      result.providersConfig[0]!.providerOptions.keep.x = 2

      expect(config.providersConfig[0]!.providerOptions.keep.x).toBe(1)
    })
  })

  describe("when it cannot finish", () => {
    it("throws instead of handing the original back", () => {
      const config: Loose = { providersConfig: [{ id: "p", apiKey: "FAKE" }] }
      Object.defineProperty(config, "unreadable", {
        enumerable: true,
        get() {
          throw new Error("cannot read this property")
        },
      })

      expect(() => getConfigWithoutCredentials(config)).toThrow("cannot read this property")
    })

    it("throws on a structure that refers to itself", () => {
      const config: Loose = { providersConfig: [{ id: "p", apiKey: "FAKE" }] }
      config.self = config

      expect(() => getConfigWithoutCredentials(config)).toThrow(/call stack/i)
    })
  })

  describe("every stored config version", () => {
    for (let version = 2; version <= LATEST_SCHEMA_VERSION; version++) {
      const versionLabel = String(version).padStart(3, "0")

      it(`leaves no apiKey or headers in the v${versionLabel} examples`, async () => {
        const { testSeries } = await import(`./example/v${versionLabel}.ts`)
        const examples = Object.values<{ config: Loose }>(testSeries)
        expect(examples.length).toBeGreaterThan(0)

        for (const { config } of examples) {
          const result = getConfigWithoutCredentials(config)

          expect(hasAPIKey(result)).toBe(false)
          expect(collectKeys(result.providersConfig)).not.toContain("apiKey")
          expect(collectKeys(result.providersConfig)).not.toContain("headers")
        }
      })
    }
  })

  /**
   * The redaction only inspects provider settings by name, because nothing outside them held a
   * credential when this was written. If a feature config gains a secret, this fails first and the
   * redaction has to learn about it.
   */
  describe("credential fields outside provider settings", () => {
    it("none exist in the default config", () => {
      const { providersConfig: _providers, ...rest } = DEFAULT_CONFIG

      const credentialNames = [...collectKeys(rest)].filter((name) =>
        /api[-_]?key|secret|password|passwd|token$|authorization|credential|cookie|header|bearer/i.test(
          name,
        ),
      )

      expect(credentialNames).toEqual([])
    })
  })
  describe("spelling and case", () => {
    // Names a credential can have. Each one must go whatever its case, in providerOptions and as a
    // query or fragment parameter.
    const CREDENTIAL_NAMES = [
      "apiKey",
      "api_key",
      "x-api-key",
      "accessToken",
      "authToken",
      "idToken",
      "refreshToken",
      "sessionToken",
      "csrfToken",
      "subscriptionKey",
      "accessKey",
      "secretAccessKey",
      "privateKey",
      "signingKey",
      "clientSecret",
      "basicAuth",
      "oauth",
      "bearer",
      "authorization",
      "password",
      "passwd",
      "credentials",
      "cookie",
      "extraHeaders",
      "defaultHeaders",
      "headers",
      "signature",
      "jwt",
      "token",
      "key",
      "sig",
      "x-sig",
      "pwd",
      "dbpwd",
    ]
    // Tuning fields and the like. None of them may go, whatever its case.
    const TUNING_NAMES = [
      "maxTokens",
      "max_tokens",
      "max_completion_tokens",
      "maxOutputTokens",
      "budgetTokens",
      "budget_tokens",
      "thinkingBudget",
      "reasoningEffort",
      "reasoning_effort",
      "textVerbosity",
      "thinkingConfig",
      "thinkingLevel",
      "includeThoughts",
      "enableThinking",
      "reasoningHistory",
      "chat_template_kwargs",
      "temperature",
      "top_p",
      "top_k",
      "topK",
      "keep_alive",
      "seed",
      "stop",
      "user",
      "metadata",
      "author",
      "tokenizer",
      "keyboard",
    ]

    function caseVariants(name: string): string[] {
      const alternating = name
        .split("")
        .map((char, i) => (i % 2 ? char.toLowerCase() : char.toUpperCase()))
      return [
        ...new Set([
          name,
          name.toLowerCase(),
          name.toUpperCase(),
          name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(),
          alternating.join(""),
        ]),
      ]
    }

    function isDroppedFromOptions(name: string): boolean {
      return !(name in redactOptions({ [name]: "FAKE-VALUE" }))
    }

    function isBlankedInQuery(name: string): boolean {
      return redactUrl(`https://h.example/v1?${name}=FAKE-VALUE`).endsWith(`?${name}=`)
    }

    function isBlankedInFragment(name: string): boolean {
      return redactUrl(`https://h.example/v1#${name}=FAKE-VALUE`).endsWith(`#${name}=`)
    }

    it.each(CREDENTIAL_NAMES.flatMap(caseVariants))("drops an entry named %s", (name) => {
      expect(isDroppedFromOptions(name)).toBe(true)
    })

    it.each(CREDENTIAL_NAMES.flatMap(caseVariants))(
      "blanks the query and fragment parameter %s",
      (name) => {
        expect(isBlankedInQuery(name)).toBe(true)
        expect(isBlankedInFragment(name)).toBe(true)
      },
    )

    it.each(TUNING_NAMES.flatMap(caseVariants))("keeps an entry named %s", (name) => {
      expect(isDroppedFromOptions(name)).toBe(false)
    })

    it.each(TUNING_NAMES.flatMap(caseVariants))("leaves a parameter named %s alone", (name) => {
      expect(redactUrl(`https://h.example/v1?${name}=7`)).toBe(`https://h.example/v1?${name}=7`)
    })

    it("treats a name the same in lower case, upper case and as written", () => {
      const names = [
        ...CREDENTIAL_NAMES,
        ...TUNING_NAMES,
        "Authorization",
        "X-Api-Key",
        "ACCESSTOKEN",
      ]
      const disagreements = names.filter((name) => {
        const decisions = [name, name.toLowerCase(), name.toUpperCase()].map(isDroppedFromOptions)
        return new Set(decisions).size !== 1
      })

      expect(disagreements).toEqual([])
    })

    it("treats a query parameter name the same in lower case, upper case and as written", () => {
      const names = [...CREDENTIAL_NAMES, ...TUNING_NAMES]
      const disagreements = names.filter((name) => {
        const decisions = [name, name.toLowerCase(), name.toUpperCase()].map(isBlankedInQuery)
        return new Set(decisions).size !== 1
      })

      expect(disagreements).toEqual([])
    })

    it("drops the case variants Astra found, in nested options and in URLs", () => {
      const result = redactProvider({
        providerOptions: {
          nested: {
            ACCESSTOKEN: "FAKE",
            accesstoken: "FAKE",
            SUBSCRIPTIONKEY: "FAKE",
            subscriptionkey: "FAKE",
            BASICAUTH: "FAKE",
            keep: 1,
          },
        },
        url: "https://example.test/v1/responses?ACCESSTOKEN=FAKE&SUBSCRIPTIONKEY=FAKE&basicauth=FAKE&ok=1",
      })

      expect(result).toEqual({
        providerOptions: { nested: { keep: 1 } },
        url: "https://example.test/v1/responses?ACCESSTOKEN=&SUBSCRIPTIONKEY=&basicauth=&ok=1",
      })
    })

    it("keeps every documented tuning option, as recommended and as defaulted", () => {
      const documented = [
        ...LLM_MODEL_OPTIONS.map(({ options }) => options),
        ...Object.values(DEFAULT_PROVIDER_CONFIG).flatMap((provider) =>
          "providerOptions" in provider && provider.providerOptions
            ? [provider.providerOptions]
            : [],
        ),
      ]
      expect(documented.length).toBeGreaterThan(0)

      for (const options of documented) {
        expect(redactOptions(structuredClone(options))).toEqual(options)
      }
    })

    // Every property name a provider schema defines survives, except the two that are credentials.
    // The name rule applies to all of providersConfig, so a field it matched would be lost from the
    // export and the file would no longer import.
    it("drops no field any provider schema defines, apart from apiKey and headers", () => {
      function fieldPaths(schema: any, prefix: string[] = []): string[][] {
        const shape = schema?.shape
        if (!shape) return []
        return Object.entries(shape).flatMap(([name, field]) => {
          const children = fieldPaths((field as any)?.unwrap?.() ?? field, [...prefix, name])
          return children.length > 0 ? children : [[...prefix, name]]
        })
      }
      function build(paths: string[][]): Loose {
        const target: Loose = {}
        for (const path of paths) {
          let node = target
          for (const part of path.slice(0, -1)) node = node[part] ??= {}
          node[path.at(-1)!] = "value"
        }
        return target
      }
      function has(value: Loose, path: string[]): boolean {
        let node: any = value
        for (const part of path) {
          if (node === null || node === undefined || typeof node !== "object" || !(part in node))
            return false
          node = node[part]
        }
        return true
      }

      expect(providerConfigSchemaList).toHaveLength(32)
      const lost: string[] = []
      for (const schema of providerConfigSchemaList) {
        const paths = fieldPaths(schema).filter(
          (path) => path[0] !== "apiKey" && path[0] !== "headers",
        )
        const result = redactProvider(build(paths))
        for (const path of paths) {
          if (!has(result, path)) lost.push(path.join("."))
        }
      }

      expect([...new Set(lost)]).toEqual([])
    })
  })

  describe("URLs the browser parses differently from the text", () => {
    // Credentials as the URL parser reports them, checked without any of the code under test.
    const CREDENTIAL_PARAM = /key|token|auth|sig|secret|pass|credential|cookie|bearer|jwt/i
    function credentialsOf(url: string): string[] {
      const parsed = new URL(url.replaceAll("{{apiKey}}", "placeholder"))
      const found: string[] = []
      if (parsed.username && parsed.username !== "placeholder") {
        found.push(`username:${parsed.username}`)
      }
      if (parsed.password && parsed.password !== "placeholder") {
        found.push(`password:${parsed.password}`)
      }
      for (const [name, value] of parsed.searchParams) {
        if (CREDENTIAL_PARAM.test(name) && value && value !== "placeholder") {
          found.push(`query:${name}=${value}`)
        }
      }
      const hash = parsed.hash.slice(1)
      if (hash.includes("=")) {
        for (const [name, value] of new URLSearchParams(hash)) {
          if (CREDENTIAL_PARAM.test(name) && value && value !== "placeholder") {
            found.push(`fragment:${name}=${value}`)
          }
        }
      }
      return found
    }

    const VECTORS: Array<[string, string, string]> = [
      [
        "a leading space",
        " https://FAKE_USER:FAKE_PASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "a trailing space",
        "https://FAKE_USER:FAKE_PASSWORD@example.test/v1 ",
        "https://example.test/v1 ",
      ],
      [
        "a leading newline",
        "\nhttps://FAKE_USER:FAKE_PASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "extra slashes",
        "https:////FAKE_USER:FAKE_PASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "backslashes after the scheme",
        "https:\\\\FAKE_USER:FAKE_PASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "a backslash and a slash",
        "https:/\\FAKE_USER:FAKE_PASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "a tab inside the userinfo",
        "https://FAKE\t_USER:FAKE_PASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "percent-encoded userinfo",
        "https://%46AKE_USER:FAKE%5FPASSWORD@example.test/v1",
        "https://example.test/v1",
      ],
      [
        "a tab inside a query name",
        "https://example.test/v1?to\tken=FAKE_TOKEN&ok=1",
        "https://example.test/v1?to\tken=&ok=1",
      ],
      [
        "a newline inside a query name",
        "https://example.test/v1?api\n_key=FAKE_KEY",
        "https://example.test/v1?api\n_key=",
      ],
      [
        "a tab inside a fragment name",
        "https://example.test/v1#access\t_token=FAKE_TOKEN&state=s",
        "https://example.test/v1#access\t_token=&state=s",
      ],
      [
        "a tab inside a name the word rule needs whole",
        "https://example.test/v1?si\tg=FAKE_SIGNATURE&ok=1",
        "https://example.test/v1?sig=&ok=1",
      ],
      [
        "a leading space and a query credential",
        " https://example.test/v1?key=FAKE_KEY",
        " https://example.test/v1?key=",
      ],
      [
        "userinfo and query together",
        " https://FAKE_USER:FAKE_PASSWORD@example.test/v1?key=FAKE_KEY&ok=1",
        "https://example.test/v1?key=&ok=1",
      ],
    ]

    it.each(VECTORS)("removes the credentials from %s", (_name, input, expected) => {
      expect(credentialsOf(input).length).toBeGreaterThan(0)

      const result = redactUrl(input)

      expect(credentialsOf(result)).toEqual([])
      expect(result).not.toMatch(/FAKE/)
      expect(result).toBe(expected)
    })

    it.each(VECTORS)("treats the open-responses url the same: %s", (_name, input) => {
      const result = redactProvider({ url: input }).url

      expect(credentialsOf(result)).toEqual([])
      expect(result).not.toMatch(/FAKE/)
    })

    it("keeps the placeholder when it has to rebuild the URL", () => {
      expect(
        redactUrl(
          " https://FAKE_USER:FAKE_PASSWORD@api.deeplx.org/{{apiKey}}/translate?key=FAKE_KEY",
        ),
      ).toBe("https://api.deeplx.org/{{apiKey}}/translate?key=")
      expect(
        redactUrl(" https://FAKE_USER@example.test/v1?token={{apiKey}}&api_key=FAKE_KEY"),
      ).toBe("https://example.test/v1?token={{apiKey}}&api_key=")
      expect(
        redactUrl("https:////FAKE_USER:FAKE_PASSWORD@{{apiKey}}.example.test/v1?to\tken=FAKE"),
      ).toBe("https://{{apiKey}}.example.test/v1?token=")
      expect(redactUrl("https://{{apiKey}}@example.test/v1?si\tg=FAKE")).toBe(
        "https://{{apiKey}}@example.test/v1?sig=",
      )
    })

    it("keeps the placeholder in a padded URL whose credentials the text pass already removed", () => {
      expect(redactUrl(" https://example.test/v1?token={{apiKey}}&api_key=FAKE_KEY")).toBe(
        " https://example.test/v1?token={{apiKey}}&api_key=",
      )
    })

    it("does not mistake a host that the parser lower-cases into the stand-in for the placeholder", () => {
      expect(redactUrl(" https://FAKE_USER@ZQPLACEHOLDERZQ.example.test/v1")).toBe(
        "https://zqplaceholderzq.example.test/v1",
      )
    })

    it("does not mistake text that merely looks like the placeholder for it", () => {
      expect(redactUrl(" https://FAKE_USER@example.test/v1?token=ZQPLACEHOLDERZQ&key=FAKE")).toBe(
        "https://example.test/v1?token=&key=",
      )
    })

    it.each([
      "https://example.test/v1",
      " https://example.test/v1",
      "https://example.test/v1 ",
      "HTTPS://Example.TEST:443/a b/%7Bx%7D?x=1&y=a b#frag",
      "https:////example.test/v1",
      "https:\\\\example.test\\v1",
      "https://example.test",
      "https://example.test/v1?model=lingo&region=eu#section",
      "https://example.test/v1?token={{apiKey}}",
      " https://api.deeplx.org/{{apiKey}}/translate",
      "https://{{apiKey}}@example.test/v1",
      "http://localhost:11434",
      "http://127.0.0.1:1234/v1/",
      "https://example.test/v1/%E2%9C%93?q=%20x",
      "localhost:11434",
      "not a url at all",
      "",
    ])("returns %j byte for byte, because there is nothing to redact", (url) => {
      expect(redactUrl(url)).toBe(url)
    })

    // A fixed-seed property test: random joins of the pieces a URL is made of, padding and slashes
    // and tabs included. Whatever comes out must hold nothing the URL parser reads as a credential,
    // and nothing here may be refused.
    it("leaves no credential the parser can see in any mix of URL pieces, and never refuses one", () => {
      const PIECES = [
        "",
        " ",
        "\t",
        "\n",
        "https:",
        "HTTP:",
        "wss:",
        "//",
        "///",
        "////",
        "\\",
        "/\\",
        "U:P@",
        "U@",
        "{{apiKey}}@",
        "u:{{apiKey}}@",
        "host.test",
        "HOST.TEST:443",
        "{{apiKey}}.host.test",
        "/v1",
        "/{{apiKey}}/x",
        "?",
        "&",
        "key=SECRET",
        "to\tken=SECRET",
        "ACCESSTOKEN=SECRET",
        "si\tg=SECRET",
        "token={{apiKey}}",
        "api%5Fkey=SECRET",
        "access+token=SECRET",
        "Pass\nword=SECRET",
        "ok=1",
        "#",
        "access_token=SECRET",
        "state=s",
        "=",
        "%0A",
        "SECRET",
        "ZQPLACEHOLDERZQ",
        "\u200b",
      ]
      let seed = 20261015
      const random = () => {
        seed ^= seed << 13
        seed >>>= 0
        seed ^= seed >>> 17
        seed ^= seed << 5
        seed >>>= 0
        return seed / 0xffffffff
      }

      const leaks: string[] = []
      for (let i = 0; i < 4000; i++) {
        let input = ""
        for (let piece = 0; piece < 2 + Math.floor(random() * 9); piece++) {
          input += PIECES[Math.floor(random() * PIECES.length)]
        }
        let output: string | undefined
        try {
          output = redactUrl(input)
        } catch {
          leaks.push(`refused: ${JSON.stringify(input)}`)
          continue
        }
        let found: string[] = []
        try {
          found = credentialsOf(output)
        } catch {
          // Not a URL the parser reads at all, so nothing there can be a credential.
        }
        if (found.length > 0) leaks.push(`${JSON.stringify(input)} -> ${JSON.stringify(output)}`)
      }

      expect(leaks).toEqual([])
    })

    it("fails closed if the credentials are still in the URL after the rebuild", () => {
      const spy = vi.spyOn(URL.prototype, "username", "set").mockImplementation(() => {})
      try {
        expect(() => redactUrl(" https://FAKE_USER:FAKE_PASSWORD@example.test/v1")).toThrow(
          "credentials",
        )
      } finally {
        spy.mockRestore()
        const url = new URL("https://FAKE_USER@example.test/")
        url.username = ""
        expect(url.username).toBe("")
      }
    })
  })
})
