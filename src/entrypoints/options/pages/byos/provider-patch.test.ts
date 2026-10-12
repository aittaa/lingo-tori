import type { ByosTarget } from "./provider-patch"
import { describe, expect, it } from "vitest"
import { mergeWithArrayOverwrite } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { buildByosProviderPatch } from "./provider-patch"

describe("BYOS feature assignment", () => {
  it.each(["page", "selection", "dictionary"] as const)(
    "applies the newly selected model to %s without replacing unrelated provider choices",
    (target: ByosTarget) => {
      const current = structuredClone(DEFAULT_CONFIG)
      const existing = {
        ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
        id: "paired-byos",
        name: "Saved BYOS provider",
        enabled: false,
        description: "Keep my settings",
        temperature: 0.4,
        model: {
          model: "use-custom-model" as const,
          isCustomModel: true as const,
          customModel: "model-a",
        },
      }
      const unrelated = structuredClone(DEFAULT_PROVIDER_CONFIG.openai)
      current.providersConfig = [existing, unrelated]
      current.pageTranslation.providerId = unrelated.id
      current.selectionToolbar.features.translate.providerId = unrelated.id
      current.selectionToolbar.builtInActions.dictionary.providerId = unrelated.id
      current.selectionToolbar.builtInActions.sentenceAnalysis.providerId = unrelated.id
      current.videoSubtitles.providerId = unrelated.id

      const next = mergeWithArrayOverwrite(
        current,
        buildByosProviderPatch(current, "model-b", target),
      )

      expect(next.providersConfig).toEqual([
        { ...existing, enabled: true, model: { ...existing.model, customModel: "model-b" } },
        unrelated,
      ])
      expect(next.pageTranslation.providerId).toBe(target === "page" ? existing.id : unrelated.id)
      expect(next.selectionToolbar.features.translate.providerId).toBe(
        target === "selection" ? existing.id : unrelated.id,
      )
      for (const action of ["dictionary", "sentenceAnalysis"] as const) {
        expect(next.selectionToolbar.builtInActions[action].providerId).toBe(
          target === "dictionary" ? existing.id : unrelated.id,
        )
      }
      expect(next.videoSubtitles).toEqual(current.videoSubtitles)
      expect(next.languageDetection).toEqual(current.languageDetection)
      expect(current.providersConfig[0]).toEqual(existing)
    },
  )
})

describe("first BYOS provider save", () => {
  it.each([undefined, "page", "selection", "dictionary"] as const)(
    "composes defaults with explicit target %s",
    (target) => {
      const current = structuredClone(DEFAULT_CONFIG)
      current.providersConfig = []
      current.videoSubtitles.providerId = "keep-stale-choice"
      const next = mergeWithArrayOverwrite(
        current,
        buildByosProviderPatch(current, "discovered-model", target),
      )
      expect(next.pageTranslation.providerId).toBe("lingotori-byos")
      expect(next.selectionToolbar.features.translate.providerId).toBe("lingotori-byos")
      expect(next.selectionToolbar.builtInActions.dictionary.providerId).toBe("lingotori-byos")
      expect(next.selectionToolbar.builtInActions.sentenceAnalysis.providerId).toBe(
        "lingotori-byos",
      )
      expect(next.videoSubtitles).toEqual(current.videoSubtitles)
      expect(next.languageDetection).toEqual(current.languageDetection)
    },
  )
  it("does not refill empty assignments when saving an existing provider", () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.providersConfig = [structuredClone(DEFAULT_PROVIDER_CONFIG.openai)]
    const next = mergeWithArrayOverwrite(
      current,
      buildByosProviderPatch(current, "discovered-model"),
    )
    expect(next.pageTranslation).toEqual(current.pageTranslation)
    expect(next.selectionToolbar).toEqual(current.selectionToolbar)
  })
  it("does not assign defaults without a discovered model", () => {
    const current = structuredClone(DEFAULT_CONFIG)
    current.providersConfig = []
    const next = mergeWithArrayOverwrite(current, buildByosProviderPatch(current, ""))
    expect(next.pageTranslation).toEqual(current.pageTranslation)
    expect(next.selectionToolbar).toEqual(current.selectionToolbar)
  })
})
