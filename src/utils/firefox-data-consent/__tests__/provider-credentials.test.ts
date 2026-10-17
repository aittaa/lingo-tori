// Which provider configurations carry an explicit credential, and the provider setting that lets the
// user declare one the extension cannot recognise.
//
// A credential is a non-empty API key or `{{apiKey}}` placeholder; credentials in the endpoint URL
// (userinfo, a credential-named query parameter); a credential-named header among the headers that
// are actually transmitted; a credential-named provider option that holds something; or the user's
// own declaration `endpointNeedsConsent`. Built-in providers on their fixed default endpoints and
// custom endpoints without any of those are keyless and are never gated.
//
// The limit, pinned below: a secret in an opaque URL path segment, in an option with an innocent
// name, or in a header with an unrecognised name is not detected. The declaration exists for it.
//
// The declaration travels with the provider: through the redacted settings export and import,
// through the provider snapshots a request is built from, and through a structured clone. Its name
// must not look like a credential name, or the export would delete it.

import type { Config } from "@/types/config/config"
import type { LLMProviderConfig } from "@/types/config/provider"
import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { llmProviderConfigItemSchema, providerConfigSchemaList } from "@/types/config/provider"
import { getConfigWithoutCredentials, isCredentialName } from "@/utils/config/api"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  optionsCarryCredentials,
  providerConfigCarriesCredentials,
} from "@/utils/firefox-data-consent"
import { getProviderHeadersWithOverride } from "@/utils/providers/headers"

const ORIGIN = "https://provider.example.test"

describe("providerConfigCarriesCredentials", () => {
  it.each<[string, Parameters<typeof providerConfigCarriesCredentials>[0], boolean]>([
    ["a non-empty API key", { apiKey: "sk-test-123" }, true],
    ["an API key of only spaces", { apiKey: "   " }, false],
    ["no key and a plain endpoint", { baseURL: `${ORIGIN}/v1` }, false],
    ["the {{apiKey}} placeholder in the endpoint", { baseURL: `${ORIGIN}/{{apiKey}}/v1` }, true],
    ["userinfo in the endpoint", { baseURL: "https://user:secret@provider.example.test/v1" }, true],
    ["a credential-named query parameter", { baseURL: `${ORIGIN}/v1?api_key=sk-test-123` }, true],
    ["an empty credential-named query parameter", { baseURL: `${ORIGIN}/v1?api_key=` }, false],
    [
      "an ordinary query parameter (api-version)",
      { baseURL: `${ORIGIN}/v1?api-version=2024-02-01` },
      false,
    ],
    ["the same checks on an open-responses url", { url: `${ORIGIN}/v1/responses?token=abc` }, true],
    ["a plain open-responses url", { url: `${ORIGIN}/v1/responses` }, false],
    ["the user's declaration alone", { baseURL: `${ORIGIN}/v1`, endpointNeedsConsent: true }, true],
    [
      "a declaration of false alone",
      { baseURL: `${ORIGIN}/v1`, endpointNeedsConsent: false },
      false,
    ],
    [
      "a declaration of false next to a key (known credentials override it)",
      { apiKey: "sk-test-123", endpointNeedsConsent: false },
      true,
    ],
    [
      "a declaration of false next to a credential in the URL",
      { baseURL: "https://u:p@provider.example.test", endpointNeedsConsent: false },
      true,
    ],
  ])("%s", (_name, config, expected) => {
    expect(providerConfigCarriesCredentials(config)).toBe(expected)
  })

  it("reads the headers that are actually transmitted, and ignores one whose value is empty", () => {
    // `getProviderHeadersWithOverride` is what the request goes out with: empty values are omitted.
    const transmitted = (headers: Record<string, unknown>) =>
      getProviderHeadersWithOverride("openai-compatible", headers)

    expect(
      providerConfigCarriesCredentials({}, transmitted({ Authorization: "Bearer sk-test" })),
    ).toBe(true)
    expect(providerConfigCarriesCredentials({}, transmitted({ "X-Session-Token": "abc" }))).toBe(
      true,
    )
    expect(providerConfigCarriesCredentials({}, transmitted({ Authorization: "" }))).toBe(false)
    expect(providerConfigCarriesCredentials({}, transmitted({ "X-Title": "LingoTori" }))).toBe(
      false,
    )
    expect(providerConfigCarriesCredentials({})).toBe(false)
  })

  it("reads credential-named provider options that hold something, at any depth", () => {
    expect(optionsCarryCredentials({ openai: { apiKey: "sk-test" } })).toBe(true)
    expect(
      optionsCarryCredentials({ "openai-compatible": { nested: { access_token: "abc" } } }),
    ).toBe(true)
    expect(optionsCarryCredentials({ openai: { apiKey: "" } })).toBe(false)
    expect(optionsCarryCredentials({ openai: { apiKey: {} } })).toBe(false)
    // Ordinary options, including names that only look close to a credential.
    expect(
      optionsCarryCredentials({
        openai: { reasoningEffort: "low", max_tokens: 512, budget_tokens: 1024, user: "u-1" },
        chat_template_kwargs: { thinking: false },
        ollama: { keep_alive: "5m", top_k: 40 },
      }),
    ).toBe(false)
    expect(
      providerConfigCarriesCredentials({ providerOptions: { openai: { apiKey: "sk-test" } } }),
    ).toBe(true)
  })

  it("does not claim to detect a secret hidden where no name gives it away", () => {
    expect(providerConfigCarriesCredentials({ baseURL: `${ORIGIN}/v1/KEY-IN-PATH-123` })).toBe(
      false,
    )
    expect(
      providerConfigCarriesCredentials({ providerOptions: { openai: { user: "KEY-IN-OPTION" } } }),
    ).toBe(false)
    expect(providerConfigCarriesCredentials({}, { "X-Proxy-Pass": "hidden-secret" })).toBe(false)
  })
})

describe("built-in providers on their fixed default endpoints", () => {
  // DeepL always sends its key, and the DeepLX default URL holds the {{apiKey}} placeholder: neither
  // works without a key, so neither is a keyless provider.
  const needsAKey = new Set(["deepl", "deeplx"])
  const keyless = Object.values(DEFAULT_PROVIDER_CONFIG).filter(
    (config) => !(config as { apiKey?: string }).apiKey?.trim() && !needsAKey.has(config.provider),
  )

  it("exist, so this check is not vacuous", () => {
    expect(keyless.length).toBeGreaterThan(10)
  })

  it.each(keyless.map((config) => [config.provider, config] as const))(
    "%s carries no credential until the user adds one",
    (_provider, config) => {
      const source = config as LLMProviderConfig
      const headers = getProviderHeadersWithOverride(source.provider, source.headers)

      expect(providerConfigCarriesCredentials(source, headers)).toBe(false)
    },
  )

  it("the DeepLX default URL holds the key placeholder, so it is credentialed", () => {
    expect(providerConfigCarriesCredentials(DEFAULT_PROVIDER_CONFIG.deeplx)).toBe(true)
  })
})

describe("the declaration endpointNeedsConsent", () => {
  it("is not a credential name, so the export does not delete it", () => {
    expect(isCredentialName("endpointNeedsConsent")).toBe(false)
    // The name it replaced would have been deleted.
    expect(isCredentialName("endpointCarriesCredential")).toBe(true)
  })

  const declared = {
    id: "custom-1",
    name: "Custom endpoint",
    enabled: true,
    provider: "openai-compatible",
    baseURL: `${ORIGIN}/v1/KEY-IN-PATH-123`,
    apiKey: "sk-test-123",
    headers: { Authorization: "Bearer sk-test-123" },
    endpointNeedsConsent: true,
    model: { model: "use-custom-model", isCustomModel: true, customModel: "m" },
  } as unknown as LLMProviderConfig

  function configWith(provider: LLMProviderConfig): Config {
    return { ...structuredClone(DEFAULT_CONFIG), providersConfig: [provider] }
  }

  it("is accepted by the provider and config schemas, with or without it", () => {
    expect(llmProviderConfigItemSchema.safeParse(declared).success).toBe(true)
    expect(
      llmProviderConfigItemSchema.safeParse({ ...declared, endpointNeedsConsent: undefined })
        .success,
    ).toBe(true)
    expect(
      llmProviderConfigItemSchema.safeParse({ ...declared, endpointNeedsConsent: "yes" }).success,
    ).toBe(false)
    expect(configSchema.safeParse(configWith(declared)).success).toBe(true)
  })

  it("is accepted on every API provider type and refused on the ChatGPT sign-in", () => {
    const apiTypes = providerConfigSchemaList.filter(
      (schema) => "endpointNeedsConsent" in schema.shape,
    )
    // Every API provider schema has it; the BYOS schema forbids it (`z.never()`).
    expect(apiTypes.length).toBeGreaterThan(20)
    const byos = {
      id: "byos",
      name: "ChatGPT",
      enabled: true,
      provider: "byos",
      endpointNeedsConsent: true,
      model: { model: "use-custom-model", isCustomModel: true, customModel: "m" },
    }
    expect(llmProviderConfigItemSchema.safeParse(byos).success).toBe(false)
  })

  it("survives the redacted settings export and an import: the retained endpoint stays gated", () => {
    const exported = getConfigWithoutCredentials(configWith(declared))
    const provider = exported.providersConfig[0] as Record<string, unknown>

    // Credentials leave; the ambiguous endpoint and the declaration about it stay.
    expect(provider.apiKey).toBeUndefined()
    expect(provider.headers).toBeUndefined()
    expect(provider.baseURL).toBe(`${ORIGIN}/v1/KEY-IN-PATH-123`)
    expect(provider.endpointNeedsConsent).toBe(true)

    const imported = configSchema.parse(JSON.parse(JSON.stringify(exported)))
    const reimported = imported.providersConfig[0] as unknown as Record<string, unknown>
    expect(reimported.endpointNeedsConsent).toBe(true)
    expect(providerConfigCarriesCredentials(reimported as never)).toBe(true)
  })

  it("survives the full export, a JSON round trip, and a structured clone (the Firefox form)", () => {
    const config = configWith(declared)

    const viaJson = configSchema.parse(JSON.parse(JSON.stringify(config)))
    const viaClone = configSchema.parse(structuredClone(config))

    for (const copy of [viaJson, viaClone]) {
      expect(
        (copy.providersConfig[0] as unknown as Record<string, unknown>).endpointNeedsConsent,
      ).toBe(true)
    }
  })

  it("travels in the provider snapshot a request is built from", () => {
    const snapshot = llmProviderConfigItemSchema.parse(JSON.parse(JSON.stringify(declared)))

    expect((snapshot as unknown as Record<string, unknown>).endpointNeedsConsent).toBe(true)
  })
})
