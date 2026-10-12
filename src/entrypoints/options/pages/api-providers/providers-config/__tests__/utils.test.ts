import type { Config } from "@/types/config/config"
import type { APIProviderConfig } from "@/types/config/provider"
import type { ConfigUpdate } from "@/utils/atoms/config"
import { describe, expect, it, vi } from "vitest"
import { mergeWithArrayOverwrite } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG, getProviderItemName } from "@/utils/constants/providers"
import { initI18n } from "@/utils/i18n"
import { addProvider, duplicateProvider } from "../utils"

type AlibabaProviderConfig = Extract<APIProviderConfig, { provider: "alibaba" }>
type OpenAICompatibleProviderConfig = Extract<APIProviderConfig, { provider: "openai-compatible" }>

function applyConfigUpdate(current: Config, update: ConfigUpdate) {
  return mergeWithArrayOverwrite(current, typeof update === "function" ? update(current) : update)
}

function createConfigWriter(initial = structuredClone(DEFAULT_CONFIG)) {
  let current = initial
  const writeConfig = vi.fn<(update: ConfigUpdate) => Promise<void>>(async (update) => {
    current = applyConfigUpdate(current, update)
  })
  return { writeConfig, getConfig: () => current }
}

describe("api provider utils", () => {
  it("adds the OpenAI-compatible provider with its localized default description", async () => {
    await initI18n("en")
    const writer = createConfigWriter()
    await addProvider("openai-compatible", writer.writeConfig)

    expect(writer.getConfig().providersConfig[0]).toEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        name: "options.apiProviders.providers.name.customChatComplete",
        description: "options.apiProviders.providers.description.openaiCompatible",
      }),
    )
  })

  it("adds Custom Responses without changing an existing custom provider name", async () => {
    await initI18n("en")
    const existingProvider: OpenAICompatibleProviderConfig = {
      id: "legacy-custom-provider",
      name: "My Custom Provider",
      enabled: true,
      provider: "openai-compatible",
      baseURL: "https://example.com/v1",
      model: {
        model: "use-custom-model",
        isCustomModel: true,
        customModel: "legacy-model",
      },
    }
    const current = structuredClone(DEFAULT_CONFIG)
    current.providersConfig = [existingProvider]
    const writer = createConfigWriter(current)
    await addProvider("open-responses", writer.writeConfig)

    expect(writer.getConfig().providersConfig[0]?.name).toBe("My Custom Provider")
    expect(writer.getConfig().providersConfig[1]).toEqual(
      expect.objectContaining({
        provider: "open-responses",
        name: "options.apiProviders.providers.name.customResponses",
        url: "https://api.example.com/v1/responses",
      }),
    )
  })

  it("persists the first provider and supported defaults in one write before selecting it", async () => {
    const writer = createConfigWriter()
    const selected = vi.fn<(id: string) => void>((id) => {
      const config = writer.getConfig()
      expect(config.providersConfig[0]?.id).toBe(id)
      expect(config.pageTranslation.providerId).toBe(id)
      expect(config.selectionToolbar.builtInActions.dictionary.providerId).toBe(id)
    })

    const id = await addProvider("openai", writer.writeConfig, selected)

    expect(writer.writeConfig).toHaveBeenCalledOnce()
    expect(typeof writer.writeConfig.mock.calls[0]?.[0]).toBe("function")
    expect(selected).toHaveBeenCalledWith(id)
  })

  it("uses the latest provider list and names when persisting after an optimistic first registration", async () => {
    await initI18n("en")
    const empty = structuredClone(DEFAULT_CONFIG)
    const latest = structuredClone(DEFAULT_CONFIG)
    const concurrent = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      id: "concurrent",
      name: getProviderItemName("openai"),
    }
    latest.providersConfig = [concurrent]
    let persisted: Config | undefined
    const writeConfig = vi.fn<(update: ConfigUpdate) => Promise<void>>(async (update) => {
      const optimistic = applyConfigUpdate(empty, update)
      expect(optimistic.pageTranslation.providerId).toBe(optimistic.providersConfig[0]?.id)
      persisted = applyConfigUpdate(latest, update)
    })

    const id = await addProvider("openai", writeConfig)

    expect(persisted?.providersConfig).toEqual([
      concurrent,
      expect.objectContaining({ id, name: `${concurrent.name} 1` }),
    ])
    expect(persisted?.pageTranslation).toEqual(latest.pageTranslation)
    expect(persisted?.selectionToolbar).toEqual(latest.selectionToolbar)
  })

  it("does not duplicate a row when an updater is reapplied to its own result", async () => {
    let current = structuredClone(DEFAULT_CONFIG)
    const writeConfig = vi.fn<(update: ConfigUpdate) => Promise<void>>(async (update) => {
      current = applyConfigUpdate(current, update)
      const firstResult = structuredClone(current)
      current = applyConfigUpdate(current, update)
      expect(current).toEqual(firstResult)
    })

    const id = await addProvider("openai", writeConfig)

    expect(current.providersConfig).toHaveLength(1)
    expect(current.providersConfig[0]?.id).toBe(id)
  })

  it("does not refill deliberately unconfigured slots on a later registration", async () => {
    const initial = structuredClone(DEFAULT_CONFIG)
    initial.providersConfig = [structuredClone(DEFAULT_PROVIDER_CONFIG.deepl)]
    const writer = createConfigWriter(initial)

    await addProvider("openai", writer.writeConfig)

    expect(writer.getConfig().providersConfig).toHaveLength(2)
    expect(writer.getConfig().pageTranslation).toEqual(initial.pageTranslation)
    expect(writer.getConfig().selectionToolbar).toEqual(initial.selectionToolbar)
  })

  it("does not select a provider if persistence fails", async () => {
    const failure = new Error("Unable to persist config")
    const writeConfig = vi.fn<(update: ConfigUpdate) => Promise<void>>(async (_update) => {
      throw failure
    })
    const selected = vi.fn<(id: string) => void>()

    await expect(addProvider("openai", writeConfig, selected)).rejects.toBe(failure)

    expect(selected).not.toHaveBeenCalled()
  })

  it("duplicates an existing provider config with a fresh id and unique name", async () => {
    const sourceProvider: AlibabaProviderConfig = {
      id: "alibaba-original",
      name: "Alibaba Cloud",
      description: "shared credentials",
      enabled: true,
      provider: "alibaba",
      apiKey: "[REDACTED]",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      temperature: 0.3,
      providerOptions: { extraBody: { enable_thinking: false } },
      headers: { "x-test": "enabled" },
      model: {
        model: "qwen3-max",
        isCustomModel: true,
        customModel: "qwen3-max",
      },
    }
    const existingCopy: AlibabaProviderConfig = {
      ...sourceProvider,
      id: "alibaba-copy",
      name: "Alibaba Cloud 1",
    }
    const providersConfig = [sourceProvider, existingCopy] as Config["providersConfig"]
    let updatedProviders: Config["providersConfig"] | undefined
    const setProvidersConfig = vi.fn<(...args: any[]) => any>(
      async (config: Partial<Config["providersConfig"]>) => {
        updatedProviders = config as Config["providersConfig"]
      },
    )
    const setSelectedProviderId = vi.fn<(...args: any[]) => any>()

    const newProviderId = await duplicateProvider(
      sourceProvider,
      providersConfig,
      setProvidersConfig,
      setSelectedProviderId,
    )

    expect(newProviderId).not.toBe(sourceProvider.id)
    expect(setProvidersConfig).toHaveBeenCalledOnce()
    expect(updatedProviders).toHaveLength(3)

    const duplicatedProvider = updatedProviders?.[2] as AlibabaProviderConfig
    expect(duplicatedProvider).toEqual({
      ...sourceProvider,
      id: newProviderId,
      name: "Alibaba Cloud 2",
    })
    expect(duplicatedProvider).not.toBe(sourceProvider)
    expect(duplicatedProvider.model).not.toBe(sourceProvider.model)
    expect(duplicatedProvider.providerOptions).not.toBe(sourceProvider.providerOptions)
    expect(duplicatedProvider.headers).not.toBe(sourceProvider.headers)
    expect(setSelectedProviderId).toHaveBeenCalledWith(newProviderId)
  })
})
