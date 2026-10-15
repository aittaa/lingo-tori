import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
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
      "monkey",
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
        const examples = Object.values(testSeries) as Array<{ config: Loose }>
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
})
