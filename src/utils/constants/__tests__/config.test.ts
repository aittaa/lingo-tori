import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import {
  DEFAULT_CONFIG,
  buildFreshDefaultConfig,
  createDefaultDictionaryAction,
  createDefaultSentenceAnalysisAction,
} from "../config"

describe("independent defaults", () => {
  it("starts local-only with no automatic translation sites", () => {
    expect(DEFAULT_CONFIG.providersConfig).toEqual([])
    expect(DEFAULT_CONFIG.pageTranslation.providerId).toBe("unconfigured")
    expect(DEFAULT_CONFIG.pageTranslation.page.autoTranslatePatterns).toEqual([])
    expect(DEFAULT_CONFIG).not.toHaveProperty("tts")
    expect(DEFAULT_CONFIG).not.toHaveProperty("inputTranslation")
    expect(configSchema.safeParse(DEFAULT_CONFIG).success).toBe(true)
  })
  it("creates independent mutable defaults", () => {
    const fresh = buildFreshDefaultConfig()
    fresh.selectionToolbar.customActions.push(createDefaultDictionaryAction())
    expect(DEFAULT_CONFIG.selectionToolbar.customActions).toEqual([])
  })
  it("provides inert structured actions", () => {
    for (const action of [createDefaultDictionaryAction(), createDefaultSentenceAnalysisAction()]) {
      expect(action.layout).toBe("")
      expect(action.outputSchema.length).toBeGreaterThan(0)
      expect(new Set(action.outputSchema.map((field) => field.id)).size).toBe(
        action.outputSchema.length,
      )
    }
    expect(DEFAULT_CONFIG.selectionToolbar.builtInActions).not.toHaveProperty("improveWriting")
  })
})
