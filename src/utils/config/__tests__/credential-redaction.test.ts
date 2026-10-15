import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    it("leaves no credential the parser can see in any mix of URL pieces, and refuses only where a placeholder is involved", () => {
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
          // Failing closed is allowed where a genuine placeholder could have been dropped or
          // moved by the parser (a dot-segment, a scheme it joined); an input without one has
          // nothing to count and must never be refused.
          if (!input.includes("{{apiKey}}")) leaks.push(`refused: ${JSON.stringify(input)}`)
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
  /**
   * `{{apiKey}}` is swapped for a stand-in while a URL goes through the parser. The parser can
   * build text out of pieces (it drops tabs and newlines, decodes percent-escapes in a host, maps
   * fullwidth letters), so a stand-in anyone could guess could be assembled from a credential or a
   * hostname and then be mistaken for a genuine placeholder, or be "restored" into one.
   */
  describe("the placeholder stand-in cannot be manufactured by URL normalization", () => {
    const CREDENTIAL_PARAM = /key|token|auth|sig|secret|pass|credential|cookie|bearer|jwt/i
    function credentialsOf(url: string): string[] {
      const parsed = new URL(url.replaceAll("{{apiKey}}", "placeholder"))
      const found: string[] = []
      if (parsed.username && parsed.username !== "placeholder") found.push("username")
      if (parsed.password && parsed.password !== "placeholder") found.push("password")
      for (const [name, value] of parsed.searchParams) {
        if (CREDENTIAL_PARAM.test(name) && value && value !== "placeholder")
          found.push(`query:${name}`)
      }
      if (parsed.hash.slice(1).includes("=")) {
        for (const [name, value] of new URLSearchParams(parsed.hash.slice(1))) {
          if (CREDENTIAL_PARAM.test(name) && value && value !== "placeholder") {
            found.push(`fragment:${name}`)
          }
        }
      }
      return found
    }
    const hostnameOf = (url: string) =>
      new URL(url.replaceAll("{{apiKey}}", "placeholder")).hostname
    const placeholdersIn = (text: string) => text.split("{{apiKey}}").length - 1

    // The five collisions the review found, and the two that also carry a genuine placeholder.
    // The old fixed stand-in was the literal `zqplaceholderzq`; each input spells it by a route the
    // parser normalizes (a tab or newline inside it, a percent-escape in a host, fullwidth letters).
    const VECTORS: Array<{ name: string; input: string; expected: string }> = [
      {
        name: "a query value, behind a tab-split name",
        input: "https://example.test/v1?si\tg=zq%70laceholderzq",
        expected: "https://example.test/v1?sig=",
      },
      {
        name: "a fragment value, behind a newline-split name",
        input: "https://example.test/v1#si\ng=zq%70laceholderzq",
        expected: "https://example.test/v1#sig=",
      },
      {
        name: "a username split by a tab",
        input: " https://zqplace\tholderzq@example.test/v1",
        expected: "https://example.test/v1",
      },
      {
        name: "a host spelled with a percent-escape",
        input: " https://U:P@zq%70laceholderzq.example.test/v1",
        expected: "https://zqplaceholderzq.example.test/v1",
      },
      {
        name: "a host spelled with fullwidth letters",
        input:
          " https://U:P@\uFF5A\uFF51\uFF50\uFF4C\uFF41\uFF43\uFF45\uFF48\uFF4F\uFF4C\uFF44\uFF45\uFF52\uFF5A\uFF51.example.test/v1",
        expected: "https://zqplaceholderzq.example.test/v1",
      },
      {
        name: "the query collision beside a genuine placeholder",
        input: "https://example.test/{{apiKey}}?si\tg=zq%70laceholderzq",
        expected: "https://example.test/{{apiKey}}?sig=",
      },
      {
        name: "the host collision beside a genuine placeholder",
        input: " https://U:P@zq%70laceholderzq.example.test/{{apiKey}}",
        expected: "https://zqplaceholderzq.example.test/{{apiKey}}",
      },
    ]

    it.each(VECTORS)(
      "removes the credential and keeps the hostname: $name",
      ({ input, expected }) => {
        const output = redactUrl(input)

        expect(output).toBe(expected)
        expect(credentialsOf(output)).toEqual([])
        expect(hostnameOf(output)).toBe(hostnameOf(input))
        expect(placeholdersIn(output)).toBe(placeholdersIn(input))
      },
    )

    it.each(VECTORS)("does the same for the open-responses url: $name", ({ input, expected }) => {
      expect(redactProvider({ url: input }).url).toBe(expected)
    })

    it.each([
      "https://api.deeplx.org/{{apiKey}}/translate",
      "https://example.test/v1?token={{apiKey}}",
      "https://{{apiKey}}@example.test/v1",
      "https://{{apiKey}}:{{apiKey}}@example.test/v1",
      "https://{{apiKey}}.example.test/v1",
      "https://example.test/v1#token={{apiKey}}",
      " https://example.test/{{apiKey}}?x=1#f={{apiKey}} ",
      // Text that only looks like the old stand-in is just text, in every component.
      "https://zqplaceholderzq.example.test/v1",
      "https://zq%70laceholderzq.example.test/v1",
      "https://example.test/zqplaceholderzq?x=zqplaceholderzq#zqplaceholderzq",
      "https://zqplaceholderzq.example.test/{{apiKey}}",
    ])("returns %j byte for byte, genuine placeholders included", (url) => {
      expect(redactUrl(url)).toBe(url)
    })

    it("refuses to rebuild a URL whose host label holds the placeholder and is not plain ASCII", () => {
      expect(() => redactUrl(" https://U:P@\u00FC{{apiKey}}.example.test/v1")).toThrow(
        /placeholder/i,
      )
      // The same URL with nothing to remove is returned as it is, and a non-ASCII host without a
      // placeholder in it is an ordinary rebuild.
      expect(redactUrl("https://\u00FC{{apiKey}}.example.test/v1")).toBe(
        "https://\u00FC{{apiKey}}.example.test/v1",
      )
      expect(redactUrl(" https://U:P@b\u00FCcher.example.test/{{apiKey}}")).toBe(
        "https://xn--bcher-kva.example.test/{{apiKey}}",
      )
    })

    it("treats a value that merely contains the placeholder as a credential, not as the placeholder", () => {
      expect(redactUrl(" https://example.test/v1?token=abc{{apiKey}}&key={{apiKey}}")).toBe(
        " https://example.test/v1?token=&key={{apiKey}}",
      )
      expect(redactUrl(" https://U:P@example.test/v1?sig=x{{apiKey}}")).toBe(
        "https://example.test/v1?sig=",
      )
    })

    describe("with a known stand-in, so a collision can be forced", () => {
      const UUID = "00000000-0000-4000-8000-000000000000"
      const STAND_IN = `zqph${UUID.replaceAll("-", "")}`
      const tabSplit = (text: string, at = 7) => `${text.slice(0, at)}\t${text.slice(at)}`
      const fullwidth = (text: string) =>
        text
          .split("")
          .map((char) =>
            /[0-9a-z]/.test(char) ? String.fromCodePoint(char.codePointAt(0)! + 0xfee0) : char,
          )
          .join("")

      beforeEach(() => {
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(UUID)
      })
      afterEach(() => {
        vi.restoreAllMocks()
      })

      it("uses a stand-in the rest of the tests can rely on", () => {
        // A forced collision below is only meaningful if the stand-in really is this one: the bare
        // text of it, written out in a URL, is already one more of it than the placeholders there.
        expect(() => redactUrl(`https://example.test/v1?si\tg=${STAND_IN}`)).toThrow(/placeholder/i)
        expect(redactUrl("https://example.test/v1?sig=zqph")).toBe("https://example.test/v1?sig=")
      })

      it.each([
        ["a query value", () => `https://example.test/v1?si\tg=${tabSplit(STAND_IN)}`],
        ["a fragment value", () => `https://example.test/v1#si\tg=${tabSplit(STAND_IN)}`],
        ["a username", () => ` https://${tabSplit(STAND_IN)}@example.test/v1`],
        ["a password", () => ` https://U:${tabSplit(STAND_IN)}@example.test/v1`],
        [
          "a host, by a percent-escape",
          () => ` https://U:P@${STAND_IN.slice(0, -1)}%30.example.test/v1`,
        ],
        [
          "a host, by fullwidth letters",
          () => ` https://U:P@${fullwidth(STAND_IN)}.example.test/v1`,
        ],
        ["a path, with no credential at all", () => `https://example.test/${tabSplit(STAND_IN)}`],
        ["a path, spelled by a tab", () => `https://example.test/v1/${tabSplit(STAND_IN, 3)}/x`],
        [
          "a query, though the genuine placeholder is in the path",
          () => `https://example.test/{{apiKey}}?x=${tabSplit(STAND_IN)}`,
        ],
        [
          "a path that already holds the genuine placeholder",
          () => `https://example.test/{{apiKey}}/${tabSplit(STAND_IN)}`,
        ],
        [
          "a fragment, though the genuine placeholder is in the query",
          () => `https://example.test/v1?token={{apiKey}}#${tabSplit(STAND_IN)}`,
        ],
      ])("refuses the URL when the parser manufactures the stand-in: %s", (_name, build) => {
        expect(() => redactUrl(build())).toThrow(/placeholder/i)
      })

      it("refuses it for the open-responses url too", () => {
        expect(() =>
          redactProvider({ url: ` https://U:P@${fullwidth(STAND_IN)}.example.test/v1` }),
        ).toThrow(/placeholder/i)
      })

      it.each([
        ["in the path", "https://api.deeplx.org/{{apiKey}}/translate"],
        ["in a query value", "https://example.test/v1?token={{apiKey}}"],
        ["as the whole userinfo", "https://{{apiKey}}@example.test/v1"],
        [
          "as a password beside a placeholder user",
          "https://{{apiKey}}:{{apiKey}}@example.test/v1",
        ],
        ["in the host", "https://{{apiKey}}.example.test/v1"],
        ["in the fragment", "https://example.test/v1#token={{apiKey}}"],
      ])("still takes a genuine placeholder %s through untouched", (_name, url) => {
        expect(redactUrl(url)).toBe(url)
        expect(redactUrl(` ${url}`)).toBe(` ${url}`)
      })

      it.each([
        [
          "path and query",
          " https://U:P@example.test/{{apiKey}}?token={{apiKey}}&sig=X",
          "https://example.test/{{apiKey}}?token={{apiKey}}&sig=",
        ],
        ["host", " https://U:P@{{apiKey}}.example.test/v1", "https://{{apiKey}}.example.test/v1"],
        [
          "userinfo",
          " https://{{apiKey}}@example.test/v1?si\tg=SECRET",
          "https://{{apiKey}}@example.test/v1?sig=",
        ],
        [
          "fragment",
          " https://U:P@example.test/v1#token={{apiKey}}&sig=X",
          "https://example.test/v1#token={{apiKey}}&sig=",
        ],
      ])(
        "puts a genuine placeholder back where it was after a rebuild: %s",
        (_name, input, expected) => {
          expect(redactUrl(input)).toBe(expected)
        },
      )

      it("refuses a rebuild whose hostname is not the one it read", () => {
        // Make clearing the userinfo move the host as a side effect, as a broken rebuild would.
        const real = Object.getOwnPropertyDescriptor(URL.prototype, "username")!
        Object.defineProperty(URL.prototype, "username", {
          configurable: true,
          // oxlint-disable-next-line typescript/unbound-method
          get: real.get,
          set(this: URL, value: string) {
            // oxlint-disable-next-line typescript/unbound-method
            Reflect.apply(real.set!, this, [value])
            this.hostname = "other.example.test"
          },
        })
        try {
          expect(() => redactUrl(" https://U:P@example.test/v1")).toThrow(/hostname|credentials/i)
        } finally {
          Object.defineProperty(URL.prototype, "username", real)
        }
        expect(redactUrl(" https://U:P@example.test/v1")).toBe("https://example.test/v1")
      })

      // A URL implementation that misbehaves while the credentials are being cleared, to reach the
      // checks that sit behind the parser: they must refuse rather than return what it produced.
      function withPatchedUrl(
        property: "username" | "href",
        patch: (real: PropertyDescriptor) => PropertyDescriptor,
        run: () => void,
      ) {
        const real = Object.getOwnPropertyDescriptor(URL.prototype, property)!
        Object.defineProperty(URL.prototype, property, { configurable: true, ...patch(real) })
        try {
          run()
        } finally {
          Object.defineProperty(URL.prototype, property, real)
        }
      }

      it("counts the decoded forms too: a stand-in spelled with an escape in a query value", () => {
        // The href keeps `%70` as written, so its count matches the one genuine placeholder; the
        // value the query check reads is decoded, and holds the stand-in a second time.
        const escaped = `${STAND_IN.slice(0, 2)}%70${STAND_IN.slice(3)}`
        expect(() => redactUrl(`https://example.test/{{apiKey}}?si\tg=${escaped}`)).toThrow(
          /placeholder/i,
        )
        expect(() => redactUrl(`https://example.test/{{apiKey}}#si\tg=${escaped}`)).toThrow(
          /placeholder/i,
        )
      })

      it("counts the decoded userinfo and path too", () => {
        const escaped = `${STAND_IN.slice(0, 2)}%70${STAND_IN.slice(3)}`
        expect(() => redactUrl(` https://${escaped}@example.test/{{apiKey}}`)).toThrow(
          /placeholder/i,
        )
        expect(() => redactUrl(`https://example.test/{{apiKey}}/${escaped}`)).toThrow(
          /placeholder/i,
        )
      })

      it("takes two genuine placeholders in one URL through, with or without a rebuild", () => {
        expect(redactUrl("https://example.test/{{apiKey}}/v1?token={{apiKey}}")).toBe(
          "https://example.test/{{apiKey}}/v1?token={{apiKey}}",
        )
        expect(redactUrl(" https://U:P@example.test/{{apiKey}}/v1?token={{apiKey}}&sig=X")).toBe(
          "https://example.test/{{apiKey}}/v1?token={{apiKey}}&sig=",
        )
        expect(redactUrl(" https://{{apiKey}}:{{apiKey}}@example.test/{{apiKey}}?si\tg=X")).toBe(
          "https://{{apiKey}}:{{apiKey}}@example.test/{{apiKey}}?sig=",
        )
      })

      it("refuses a rebuild the parser reads as holding a stand-in nobody wrote", () => {
        withPatchedUrl(
          "href",
          (real) => ({
            get(this: URL) {
              // oxlint-disable-next-line typescript/unbound-method
              const value = Reflect.apply(real.get!, this, []) as string
              // Only the rebuilt URL (its userinfo cleared) gets the stand-in spelled across a tab.
              return value.includes("@") ? value : `${value}#${tabSplit(STAND_IN)}`
            },
          }),
          () => {
            expect(() => redactUrl(" https://U:P@example.test/v1")).toThrow(/credentials/i)
          },
        )
      })

      it("refuses a rebuild that gained a placeholder in the userinfo", () => {
        withPatchedUrl(
          "username",
          (real) => ({
            // oxlint-disable-next-line typescript/unbound-method
            get: real.get,
            set(this: URL) {
              // oxlint-disable-next-line typescript/unbound-method
              Reflect.apply(real.set!, this, [STAND_IN])
            },
          }),
          () => {
            expect(() => redactUrl(" https://U:P@example.test/v1")).toThrow(
              /credentials|placeholder/i,
            )
          },
        )
      })

      it("leaves no credential and no changed hostname in any mix of pieces that spell the stand-in", () => {
        const PIECES = [
          "",
          " ",
          "\t",
          "https://",
          "https:////",
          "\\",
          "U:P@",
          "{{apiKey}}",
          "{{apiKey}}@",
          ".example.test",
          "/v1",
          "/",
          "?",
          "&",
          "#",
          "sig=",
          "si\tg=",
          "token=",
          "x=",
          STAND_IN,
          tabSplit(STAND_IN, 3),
          tabSplit(STAND_IN, 11),
          `${STAND_IN.slice(0, -1)}%30`,
          `${STAND_IN.slice(0, 4)}%${STAND_IN.charCodeAt(4).toString(16)}${STAND_IN.slice(5)}`,
          fullwidth(STAND_IN),
          fullwidth(STAND_IN.slice(0, 4)),
          STAND_IN.slice(0, 4),
          STAND_IN.slice(4),
          STAND_IN.toUpperCase(),
        ]
        let seed = 20261016
        const random = () => {
          seed ^= seed << 13
          seed >>>= 0
          seed ^= seed >>> 17
          seed ^= seed << 5
          seed >>>= 0
          return seed / 0xffffffff
        }

        const wrong: string[] = []
        let refused = 0
        for (let i = 0; i < 4000; i++) {
          let input = ""
          for (let piece = 0; piece < 2 + Math.floor(random() * 8); piece++) {
            input += PIECES[Math.floor(random() * PIECES.length)]
          }
          let output: string
          try {
            output = redactUrl(input)
          } catch {
            refused++
            continue
          }
          try {
            const bad =
              credentialsOf(output).length > 0 ||
              hostnameOf(output) !== hostnameOf(input) ||
              placeholdersIn(output) > placeholdersIn(input)
            if (bad) wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(output)}`)
          } catch {
            // An input the parser does not read: only the text pass applied, nothing to compare.
          }
        }

        expect(wrong).toEqual([])
        // The pieces really do force collisions: a good share of the inputs must have been refused.
        expect(refused).toBeGreaterThan(50)
      })
    })

    it("leaves no credential, no changed hostname and no new placeholder in any mix of pieces, with a random stand-in, and refuses only where a placeholder is involved", () => {
      const PIECES = [
        "",
        " ",
        "\t",
        "\n",
        "https://",
        "https:////",
        "U:P@",
        "{{apiKey}}",
        "{{apiKey}}@",
        ".example.test",
        "/v1",
        "?",
        "&",
        "#",
        "sig=",
        "si\tg=",
        "token=",
        "zqplaceholderzq",
        "zq%70laceholderzq",
        "zqplace\tholderzq",
        "zqplace\nholderzq",
        "\uFF5A\uFF51\uFF50\uFF4C\uFF41\uFF43\uFF45\uFF48\uFF4F\uFF4C\uFF44\uFF45\uFF52\uFF5A\uFF51",
        "zqph",
        "zq%70h",
        "ZQPLACEHOLDERZQ",
      ]
      let seed = 20261017
      const random = () => {
        seed ^= seed << 13
        seed >>>= 0
        seed ^= seed >>> 17
        seed ^= seed << 5
        seed >>>= 0
        return seed / 0xffffffff
      }

      const wrong: string[] = []
      for (let i = 0; i < 4000; i++) {
        let input = ""
        for (let piece = 0; piece < 2 + Math.floor(random() * 8); piece++) {
          input += PIECES[Math.floor(random() * PIECES.length)]
        }
        let output: string
        try {
          output = redactUrl(input)
        } catch (error) {
          // Failing closed is allowed, but only where a genuine placeholder could have been
          // dropped or moved by the parser; an input without one has nothing to count.
          if (!input.includes("{{apiKey}}")) {
            wrong.push(`refused ${JSON.stringify(input)}: ${(error as Error).message}`)
          }
          continue
        }
        try {
          const bad =
            credentialsOf(output).length > 0 ||
            hostnameOf(output) !== hostnameOf(input) ||
            placeholdersIn(output) > placeholdersIn(input)
          if (bad) wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(output)}`)
        } catch {
          // Not a URL the parser reads at all.
        }
      }

      expect(wrong).toEqual([])
    })
  })
})
