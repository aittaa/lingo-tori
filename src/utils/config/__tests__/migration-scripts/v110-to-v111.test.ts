import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { migrate } from "../../migration-scripts/v110-to-v111"

describe("LingoTori migration", () => {
  it("keeps BYOK credentials, identity and models without mutating input", () => {
    const provider = {
      ...DEFAULT_PROVIDER_CONFIG.openai,
      id: "user-provider",
      apiKey: "fixture-only-secret",
      baseURL: "https://fixture.invalid/v1",
      enabled: true,
    }
    const original = {
      ...structuredClone(DEFAULT_CONFIG),
      providersConfig: [provider, { id: "google-translate-default", provider: "google-translate" }],
      tts: { voice: "old" },
      inputTranslation: { enabled: true },
      uiLanguage: "zh-CN",
    }
    original.pageTranslation.providerId = provider.id
    const migrated = migrate(original)
    expect(migrated.providersConfig).toEqual([provider])
    expect(migrated.pageTranslation.providerId).toBe(provider.id)
    expect(migrated).not.toHaveProperty("tts")
    expect(migrated).not.toHaveProperty("inputTranslation")
    expect(migrated.uiLanguage).toBe("auto")
    expect(original.providersConfig).toHaveLength(2)
    expect(configSchema.safeParse(migrated).success).toBe(true)
    expect(migrate(migrated)).toEqual(migrated)
  })
  it("retires hosted refs and executable layouts without deleting user actions", () => {
    const original = structuredClone(DEFAULT_CONFIG) as any
    original.pageTranslation.providerId = "read-frog-free-ai"
    original.languageDetection = { mode: "llm", providerId: "read-frog-advance-ai" }
    original.selectionToolbar.features.speak = { enabled: true }
    original.selectionToolbar.builtInActions.improveWriting = { enabled: true, providerId: "old" }
    original.selectionToolbar.customActions = [
      {
        id: "my-action",
        providerId: "old",
        layout: "fixture markup",
        notebaseConnection: { id: "old" },
      },
    ]
    const migrated = migrate(original)
    expect(migrated.pageTranslation.providerId).toBe("unconfigured")
    expect(migrated.languageDetection).toEqual({ mode: "basic" })
    expect(migrated.selectionToolbar.features).not.toHaveProperty("speak")
    expect(migrated.selectionToolbar.builtInActions).not.toHaveProperty("improveWriting")
    expect(migrated.selectionToolbar.customActions).toEqual([
      { id: "my-action", providerId: "unconfigured", layout: "" },
    ])
  })
  it("accepts a fresh provider-free config", () => {
    expect(DEFAULT_CONFIG.providersConfig).toEqual([])
    expect(configSchema.safeParse(DEFAULT_CONFIG).success).toBe(true)
  })
})
