import { describe, expect, it } from "vitest"
import { mergeWithArrayOverwrite } from "@/utils/atoms/config"
import { buildFirstProviderDefaultsPatch } from "@/utils/config/first-provider-defaults"
import { createDefaultDictionaryAction, DEFAULT_CONFIG } from "@/utils/constants/config"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"

describe("first provider defaults", () => {
  it.each(["openai", "byos"] as const)(
    "assigns supported empty slots for first %s registration",
    (type) => {
      const current = structuredClone(DEFAULT_CONFIG)
      const provider = { ...structuredClone(DEFAULT_PROVIDER_CONFIG[type]), id: "first" }
      current.pageTranslation.node.enabled = false
      current.selectionToolbar.builtInActions.dictionary.enabled = false
      current.selectionToolbar.features.translate.providerId = ""
      const original = structuredClone(current)

      const next = mergeWithArrayOverwrite(
        current,
        buildFirstProviderDefaultsPatch(current, provider),
      )

      for (const feature of FEATURE_KEYS) {
        expect(FEATURE_PROVIDER_DEFS[feature].getProviderId(next)).toBe(provider.id)
      }
      expect(next.selectionToolbar.builtInActions.dictionary.providerId).toBe(provider.id)
      expect(next.selectionToolbar.builtInActions.sentenceAnalysis.providerId).toBe(provider.id)
      expect(next.pageTranslation.node.enabled).toBe(false)
      expect(next.selectionToolbar.noteSuggestion.enabled).toBe(false)
      expect(next.selectionToolbar.builtInActions.dictionary.enabled).toBe(false)
      expect(next.languageDetection).toEqual(current.languageDetection)
      expect(next.selectionToolbar.customActions).toEqual(current.selectionToolbar.customActions)
      expect(next.providersConfig).toEqual([])
      expect(current).toEqual(original)
    },
  )

  it("assigns translation slots without assigning LLM slots for a translation-only provider", () => {
    const current = structuredClone(DEFAULT_CONFIG)
    const provider = { ...structuredClone(DEFAULT_PROVIDER_CONFIG.deepl), id: "translation-only" }
    const next = mergeWithArrayOverwrite(
      current,
      buildFirstProviderDefaultsPatch(current, provider),
    )

    expect(next.pageTranslation.providerId).toBe(provider.id)
    expect(next.videoSubtitles.providerId).toBe(provider.id)
    expect(next.selectionToolbar.features.translate.providerId).toBe(provider.id)
    expect(next.selectionToolbar.noteSuggestion).toEqual(current.selectionToolbar.noteSuggestion)
    expect(next.selectionToolbar.builtInActions).toEqual(current.selectionToolbar.builtInActions)
  })

  it("preserves every nonempty existing choice, including stale IDs", () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.pageTranslation.providerId = "old-page-provider"
    current.videoSubtitles.providerId = "old-subtitle-provider"
    current.selectionToolbar.features.translate.providerId = "old-selection-provider"
    current.selectionToolbar.noteSuggestion.providerId = "old-note-provider"
    current.selectionToolbar.builtInActions.dictionary.providerId = "old-dictionary-provider"
    current.selectionToolbar.builtInActions.sentenceAnalysis.providerId = "old-analysis-provider"

    expect(buildFirstProviderDefaultsPatch(current, DEFAULT_PROVIDER_CONFIG.openai)).toEqual({})
  })

  it("preserves unrelated toolbar settings and custom actions while filling empty built-in slots", () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.selectionToolbar.builtInActions.dictionary.providerId = "chosen"
    current.selectionToolbar.customActions = [
      {
        ...createDefaultDictionaryAction(),
        id: "user-action",
        providerId: "unconfigured",
      },
    ]
    const provider = { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: "first" }
    const next = mergeWithArrayOverwrite(
      current,
      buildFirstProviderDefaultsPatch(current, provider),
    )

    expect(next.selectionToolbar.builtInActions.dictionary).toEqual(
      current.selectionToolbar.builtInActions.dictionary,
    )
    expect(next.selectionToolbar.builtInActions.sentenceAnalysis.providerId).toBe(provider.id)
    expect(next.selectionToolbar.customActions).toEqual(current.selectionToolbar.customActions)
    expect(next.selectionToolbar.order).toEqual(current.selectionToolbar.order)
    expect(next.selectionToolbar.features.translate.shortcut).toEqual(
      current.selectionToolbar.features.translate.shortcut,
    )
  })

  it("does not fill empty slots when any provider already exists", () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.providersConfig = [{ ...DEFAULT_PROVIDER_CONFIG.deepl, enabled: false }]
    expect(buildFirstProviderDefaultsPatch(current, DEFAULT_PROVIDER_CONFIG.openai)).toEqual({})
  })

  it("does not assign a disabled first provider", () => {
    expect(
      buildFirstProviderDefaultsPatch(structuredClone(DEFAULT_CONFIG), {
        ...DEFAULT_PROVIDER_CONFIG.openai,
        enabled: false,
      }),
    ).toEqual({})
  })
})
