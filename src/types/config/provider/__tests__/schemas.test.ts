import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  getProviderIdsForCapability,
  resolveProviderRefForCapability,
} from "@/utils/providers/provider-registry"
import {
  apiProviderConfigItemSchema,
  llmProviderConfigItemSchema,
  providersConfigSchema,
} from "../schemas"

describe("BYOS provider compatibility", () => {
  it("preserves the stored row and accepts it for LLM features", () => {
    const provider = DEFAULT_PROVIDER_CONFIG.byos
    expect(providersConfigSchema.parse([provider])).toEqual([provider])
    expect(llmProviderConfigItemSchema.parse(provider)).toEqual(provider)
  })

  it("keeps BYOS out of the API-key editor schema", () => {
    expect(apiProviderConfigItemSchema.safeParse(DEFAULT_PROVIDER_CONFIG.byos).success).toBe(false)
  })

  it.each(["apiKey", "baseURL", "headers"])("rejects extension-owned %s on BYOS", (field) => {
    const value = field === "headers" ? { Authorization: "test-key" } : "test-value"
    expect(
      providersConfigSchema.safeParse([{ ...DEFAULT_PROVIDER_CONFIG.byos, [field]: value }])
        .success,
    ).toBe(false)
  })
  it("preserves inactive assignments and unrelated BYOK settings without selecting or invoking the row", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    const inert = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
      id: "legacy-experimental",
      enabled: false,
    }
    const byok = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      apiKey: "synthetic-byok-key",
    }
    config.providersConfig = [inert, byok]
    config.pageTranslation.providerId = inert.id
    config.videoSubtitles.providerId = inert.id
    config.selectionToolbar.features.translate.providerId = inert.id
    config.selectionToolbar.noteSuggestion.providerId = inert.id
    config.selectionToolbar.builtInActions.dictionary.providerId = inert.id
    config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = inert.id
    config.languageDetection = { ...config.languageDetection, mode: "llm", providerId: inert.id }
    const preserved = configSchema.parse(config)
    expect(preserved.providersConfig).toEqual(config.providersConfig)
    expect(preserved.pageTranslation.providerId).toBe(inert.id)
    for (const capability of [
      "pageTranslation",
      "videoSubtitles",
      "selectionTranslation",
      "customAction",
      "languageDetection",
    ] as const) {
      expect(
        getProviderIdsForCapability(capability, preserved.providersConfig, { requireEnable: true }),
      ).not.toContain(inert.id)
      expect(
        resolveProviderRefForCapability(capability, preserved.providersConfig, inert.id),
      ).toBeNull()
    }
  })
})
