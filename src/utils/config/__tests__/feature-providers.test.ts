import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getProviderIdsForCapability } from "@/utils/providers/provider-registry"
import {
  computeProviderFallbacksAfterDeletion,
  computeSelectionToolbarCustomActionFallbacksAfterDeletion,
  computeLanguageDetectionFallbackAfterDeletion,
  resolveLanguageDetectionConfigForModeChange,
} from "../helpers"

describe("local provider assignments", () => {
  it("has no implicit hosted or free provider", () => {
    expect(getProviderIdsForCapability("pageTranslation", [])).toEqual([])
    expect(resolveLanguageDetectionConfigForModeChange({ mode: "basic" }, "llm", [])).toBeNull()
  })
  it("unconfigures features when the last provider is removed", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.pageTranslation.providerId = "mine"
    config.selectionToolbar.builtInActions.dictionary.providerId = "mine"
    config.languageDetection = { mode: "llm", providerId: "mine" }
    expect(computeProviderFallbacksAfterDeletion("mine", config, [])).toEqual({
      pageTranslation: "unconfigured",
    })
    expect(
      computeSelectionToolbarCustomActionFallbacksAfterDeletion("mine", config, [])?.builtInActions
        .dictionary.providerId,
    ).toBe("unconfigured")
    expect(computeLanguageDetectionFallbackAfterDeletion("mine", config, [])).toBeUndefined()
  })
  it("chooses another enabled user provider", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.pageTranslation.providerId = "removed"
    const providers = [
      { ...DEFAULT_PROVIDER_CONFIG.openai, id: "disabled", enabled: false },
      { ...DEFAULT_PROVIDER_CONFIG.openai, id: "remaining", enabled: true },
    ]
    expect(computeProviderFallbacksAfterDeletion("removed", config, providers)).toEqual({
      pageTranslation: "remaining",
    })
    expect(
      resolveLanguageDetectionConfigForModeChange({ mode: "basic" }, "llm", providers),
    ).toEqual({ mode: "llm", providerId: "remaining" })
  })
})
