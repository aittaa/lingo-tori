// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { Config } from "@/types/config/config"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { saveAs } from "file-saver"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { configSchema } from "@/types/config/config"
import { migrateConfig } from "@/utils/config/migration"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { useExportConfig } from "../use-export-config"

vi.mock("file-saver", () => ({ saveAs: vi.fn<(data: Blob, filename?: string) => void>() }))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: vi.fn<() => void>() } }))
vi.mock("@/utils/glossary/sync/local-store", () => ({
  readLocalGlossary: vi.fn<() => Promise<{ glossaries: never[]; terms: never[] }>>(async () => ({
    glossaries: [],
    terms: [],
  })),
}))

/**
 * Every value below is a made-up string. Each one stands for a place a real credential can sit in a
 * provider config, and the "Exclude API keys" export must not carry any of them.
 */
const SECRETS = {
  apiKey: "FAKE-APIKEY-0001",
  authorizationHeader: "FAKE-HEADER-AUTHORIZATION-0002",
  lowercaseAuthorizationHeader: "FAKE-HEADER-LOWERCASE-AUTHORIZATION-0003",
  xApiKeyHeader: "FAKE-HEADER-X-API-KEY-0004",
  customNamedHeader: "FAKE-HEADER-CUSTOM-NAME-0005",
  providerOptionsApiKey: "FAKE-OPTIONS-APIKEY-0006",
  providerOptionsExtraHeader: "FAKE-OPTIONS-EXTRA-HEADER-0007",
  providerOptionsToken: "FAKE-OPTIONS-TOKEN-0008",
  providerOptionsNestedSecret: "FAKE-OPTIONS-NESTED-SECRET-0009",
  urlUserinfoName: "FAKE-URL-USER-0010",
  urlUserinfoPassword: "FAKE-URL-PASSWORD-0011",
  queryKey: "FAKE-QUERY-KEY-0012",
  queryApiKeyUppercase: "FAKE-QUERY-API-KEY-UPPERCASE-0013",
  queryTokenMixedCase: "FAKE-QUERY-TOKEN-MIXEDCASE-0014",
  queryAccessToken: "FAKE-QUERY-ACCESS-TOKEN-0015",
  responsesUrlUserinfo: "FAKE-RESPONSES-URL-USERINFO-0016",
  anthropicXApiKeyHeader: "FAKE-ANTHROPIC-X-API-KEY-HEADER-0017",
} as const

const CLAUDE_MODEL = { model: "claude-haiku-5-5", isCustomModel: false, customModel: null } as const

function buildConfig(): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    {
      ...DEFAULT_PROVIDER_CONFIG.byos,
    },
    {
      id: "custom-gateway",
      name: "Custom gateway",
      enabled: true,
      provider: "openai-compatible",
      model: { model: "use-custom-model", isCustomModel: true, customModel: "lingo-model" },
      baseURL:
        `https://${SECRETS.urlUserinfoName}:${SECRETS.urlUserinfoPassword}@gateway.example.com/v1` +
        `?model=lingo&key=${SECRETS.queryKey}&API_KEY=${SECRETS.queryApiKeyUppercase}` +
        `&Token=${SECRETS.queryTokenMixedCase}&access_token=${SECRETS.queryAccessToken}&region=eu`,
      apiKey: SECRETS.apiKey,
      headers: {
        Authorization: `Bearer ${SECRETS.authorizationHeader}`,
        authorization: `Bearer ${SECRETS.lowercaseAuthorizationHeader}`,
        "x-api-key": SECRETS.xApiKeyHeader,
        "X-Gateway-Pass": SECRETS.customNamedHeader,
        "X-Trace": "harmless-trace-value",
      },
      providerOptions: {
        reasoningEffort: "low",
        budgetTokens: 2048,
        chat_template_kwargs: { thinking: false },
        api_key: SECRETS.providerOptionsApiKey,
        extra_headers: { "X-Upstream": SECRETS.providerOptionsExtraHeader },
        gateway_token: SECRETS.providerOptionsToken,
        routing: { fallbacks: ["a", "b"], client_secret: SECRETS.providerOptionsNestedSecret },
      },
    },
    {
      id: "responses-gateway",
      name: "Responses gateway",
      enabled: true,
      provider: "open-responses",
      model: { model: "use-custom-model", isCustomModel: true, customModel: "lingo-responses" },
      url: `https://responses-user:${SECRETS.responsesUrlUserinfo}@responses.example.com/v1/responses`,
      apiKey: SECRETS.apiKey,
    },
    {
      id: "deeplx-placeholder-path",
      name: "DeepLX placeholder in the path",
      enabled: true,
      provider: "deeplx",
      baseURL: "https://api.deeplx.org/{{apiKey}}/translate",
      apiKey: SECRETS.apiKey,
    },
    {
      id: "deeplx-placeholder-query",
      name: "DeepLX placeholder in the query",
      enabled: true,
      provider: "deeplx",
      baseURL: "https://deeplx.example.com/translate?token={{apiKey}}",
      apiKey: SECRETS.apiKey,
    },
    {
      id: "claude",
      name: "Claude",
      enabled: true,
      provider: "anthropic",
      model: CLAUDE_MODEL,
      apiKey: SECRETS.apiKey,
      headers: { "X-Api-Key": SECRETS.anthropicXApiKeyHeader },
      providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } },
    },
  ]
  return config
}

/** What the credential-free export should leave of `buildConfig()`. */
function buildExpectedProviders(): Config["providersConfig"] {
  return [
    DEFAULT_PROVIDER_CONFIG.byos,
    {
      id: "custom-gateway",
      name: "Custom gateway",
      enabled: true,
      provider: "openai-compatible",
      model: { model: "use-custom-model", isCustomModel: true, customModel: "lingo-model" },
      baseURL:
        "https://gateway.example.com/v1?model=lingo&key=&API_KEY=&Token=&access_token=&region=eu",
      providerOptions: {
        reasoningEffort: "low",
        budgetTokens: 2048,
        chat_template_kwargs: { thinking: false },
        routing: { fallbacks: ["a", "b"] },
      },
    },
    {
      id: "responses-gateway",
      name: "Responses gateway",
      enabled: true,
      provider: "open-responses",
      model: { model: "use-custom-model", isCustomModel: true, customModel: "lingo-responses" },
      url: "https://responses.example.com/v1/responses",
    },
    {
      id: "deeplx-placeholder-path",
      name: "DeepLX placeholder in the path",
      enabled: true,
      provider: "deeplx",
      baseURL: "https://api.deeplx.org/{{apiKey}}/translate",
    },
    {
      id: "deeplx-placeholder-query",
      name: "DeepLX placeholder in the query",
      enabled: true,
      provider: "deeplx",
      baseURL: "https://deeplx.example.com/translate?token={{apiKey}}",
    },
    {
      id: "claude",
      name: "Claude",
      enabled: true,
      provider: "anthropic",
      model: CLAUDE_MODEL,
      providerOptions: { thinking: { type: "enabled", budgetTokens: 1024 } },
    },
  ] as Config["providersConfig"]
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The export was not text"))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function renderExport(config: Config) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useExportConfig({ config, schemaVersion: CONFIG_SCHEMA_VERSION }), {
    wrapper,
  })
}

/** Runs the real hook and returns the JSON text it handed to the download. */
async function exportJson(config: Config, includeApiKeys: boolean): Promise<string> {
  const { result } = renderExport(config)
  await act(async () => {
    await result.current.mutateAsync(includeApiKeys)
  })
  const blob = vi.mocked(saveAs).mock.calls.at(-1)?.[0]
  expect(blob).toBeInstanceOf(Blob)
  return readBlob(blob as Blob)
}

describe("useExportConfig credential-free export", () => {
  beforeEach(() => {
    vi.mocked(saveAs).mockClear()
  })

  it("leaves every fake secret out of the file, wherever it was placed", async () => {
    const json = await exportJson(buildConfig(), false)

    const leaked = Object.entries(SECRETS)
      .filter(([, secret]) => json.includes(secret))
      .map(([name]) => name)
    expect(leaked).toEqual([])
  })

  it.each(Object.entries(SECRETS))("does not write the %s value", async (_name, secret) => {
    const json = await exportJson(buildConfig(), false)

    expect(json).not.toContain(secret)
  })

  it("drops the apiKey and headers properties of every provider", async () => {
    const exported = JSON.parse(await exportJson(buildConfig(), false)) as { config: Config }

    for (const provider of exported.config.providersConfig) {
      expect(provider).not.toHaveProperty("apiKey")
      expect(provider).not.toHaveProperty("headers")
    }
  })

  it("keeps everything that is not a credential, and the {{apiKey}} placeholder as typed", async () => {
    const exported = JSON.parse(await exportJson(buildConfig(), false)) as { config: Config }

    expect(exported.config.providersConfig).toEqual(buildExpectedProviders())
    const { providersConfig: _providers, ...rest } = exported.config
    const { providersConfig: _defaultProviders, ...defaultRest } = DEFAULT_CONFIG
    expect(rest).toEqual(defaultRest)
  })

  it("writes the schema version beside the config", async () => {
    const exported = JSON.parse(await exportJson(buildConfig(), false)) as {
      schemaVersion: number
    }

    expect(exported.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("does not change the config it was given", async () => {
    const config = buildConfig()
    const before = structuredClone(config)

    await exportJson(config, false)

    expect(config).toEqual(before)
  })

  it("imports again through the real migration and schema path with no apiKey or headers", async () => {
    const exported = JSON.parse(await exportJson(buildConfig(), false)) as {
      config: unknown
      schemaVersion: number
    }

    expect(configSchema.safeParse(exported.config).success).toBe(true)
    const imported = await migrateConfig(exported.config, exported.schemaVersion)

    expect(imported.providersConfig.map((provider) => provider.id)).toEqual(
      buildConfig().providersConfig.map((provider) => provider.id),
    )
    for (const provider of imported.providersConfig) {
      expect(provider).not.toHaveProperty("apiKey")
      expect(provider).not.toHaveProperty("headers")
    }
  })

  it("refuses to write a file when the credentials cannot be removed", async () => {
    const config = buildConfig()
    const plain = structuredClone(config)
    // Reading this property throws, so the redaction has nowhere to go. The file would still be
    // writable from the original object because `toJSON` (not enumerable, so the redaction never
    // sees it) hands the serializer the secrets as plain data: exactly what a fail-open export
    // would write.
    Object.defineProperty(config, "unreadable", {
      enumerable: true,
      get() {
        throw new Error("cannot read this property")
      },
    })
    Object.defineProperty(config, "toJSON", { enumerable: false, value: () => plain })

    const { result } = renderExport(config)
    await act(async () => {
      await expect(result.current.mutateAsync(false)).rejects.toThrow("nothing was exported")
    })

    expect(saveAs).not.toHaveBeenCalled()
  })
})

describe("useExportConfig export with API keys", () => {
  beforeEach(() => {
    vi.mocked(saveAs).mockClear()
  })

  it("still writes the whole config, every secret included", async () => {
    const config = buildConfig()
    const json = await exportJson(config, true)

    for (const secret of Object.values(SECRETS)) {
      expect(json).toContain(secret)
    }
    expect((JSON.parse(json) as { config: Config }).config).toEqual(config)
  })

  it("imports again through the real migration and schema path unchanged", async () => {
    const exported = JSON.parse(await exportJson(buildConfig(), true)) as {
      config: unknown
      schemaVersion: number
    }

    const imported = await migrateConfig(exported.config, exported.schemaVersion)

    expect(imported.providersConfig).toEqual(buildConfig().providersConfig)
  })
})
