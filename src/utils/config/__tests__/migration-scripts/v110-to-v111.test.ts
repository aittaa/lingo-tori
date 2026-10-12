import type { ProvidersConfig } from "@/types/config/provider"
import { describe, expect, it } from "vitest"
import { configSchema } from "@/types/config/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  getProviderIdsForCapability,
  resolveProviderRefForCapability,
} from "@/utils/providers/provider-registry"
import { migrate } from "../../migration-scripts/v110-to-v111"

function configWithAssignments(providersConfig: ProvidersConfig, providerId: string) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = providersConfig
  config.pageTranslation.providerId = providerId
  config.videoSubtitles.providerId = providerId
  config.selectionToolbar.features.translate.providerId = providerId
  config.selectionToolbar.noteSuggestion.providerId = providerId
  config.selectionToolbar.builtInActions.dictionary.providerId = providerId
  config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = providerId
  config.selectionToolbar.customActions = [
    {
      id: "legacy-action",
      name: "Legacy action",
      icon: "tabler:book",
      providerId,
      systemPrompt: "Keep this prompt",
      prompt: "Keep this selection prompt",
      outputSchema: [{ id: "result", name: "Result", type: "string", description: "Saved field" }],
      layout: "",
      sampleData: {
        selection: "Saved selection",
        targetCode: "eng",
        values: { result: "Saved result" },
      },
    },
  ]
  config.languageDetection = { mode: "llm", providerId }
  config.translationHub.selectedProviderIds = [providerId]
  return config
}

function expectUnconfiguredAssignments(config: ReturnType<typeof configWithAssignments>) {
  expect(config.pageTranslation.providerId).toBe("unconfigured")
  expect(config.videoSubtitles.providerId).toBe("unconfigured")
  expect(config.selectionToolbar.features.translate.providerId).toBe("unconfigured")
  expect(config.selectionToolbar.noteSuggestion.providerId).toBe("unconfigured")
  expect(config.selectionToolbar.builtInActions.dictionary.providerId).toBe("unconfigured")
  expect(config.selectionToolbar.builtInActions.sentenceAnalysis.providerId).toBe("unconfigured")
  expect(config.selectionToolbar.customActions[0]?.providerId).toBe("unconfigured")
  expect(config.languageDetection).toEqual({ mode: "basic" })
  expect(config.translationHub.selectedProviderIds).toEqual([])
}

describe("LingoTori migration", () => {
  it.each([true, false])("preserves BYOS assignments and honors enabled=%s", (enabled) => {
    const inert = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
      id: "legacy-experimental",
      enabled,
      description: "Keep this historical row",
      model: {
        model: "use-custom-model" as const,
        isCustomModel: true as const,
        customModel: "saved-model",
      },
    }
    const byok = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      id: "available-byok",
      enabled: true,
    }
    const original = configWithAssignments([inert, byok], inert.id)
    const snapshot = structuredClone(original)

    const migrated = migrate(original)

    expect(migrated).toEqual(snapshot)
    expect(original).toEqual(snapshot)
    expect(configSchema.safeParse(migrated).success).toBe(true)
    expect(migrate(migrated)).toEqual(migrated)
    for (const capability of [
      "pageTranslation",
      "videoSubtitles",
      "selectionTranslation",
      "noteSuggestion",
      "customAction",
      "languageDetection",
    ] as const) {
      expect(
        getProviderIdsForCapability(capability, migrated.providersConfig, {
          requireEnable: true,
        }).includes(inert.id),
      ).toBe(enabled)
      expect(
        Boolean(resolveProviderRefForCapability(capability, migrated.providersConfig, inert.id)),
      ).toBe(enabled)
    }
  })

  it.each([
    "google-translate",
    "microsoft-translate",
    "read-frog-free-ai",
    "read-frog-advance-ai",
    "system",
  ])("still retires %s rows and their assignments", (retired) => {
    const byok = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      id: "available-byok",
      enabled: true,
    }
    const original = configWithAssignments([byok], `old-${retired}`) as any
    original.providersConfig.push({ id: `old-${retired}`, provider: retired, enabled: true })
    const migrated = migrate(original)
    expect(migrated.providersConfig).toEqual([byok])
    expectUnconfiguredAssignments(migrated)
    expect(configSchema.safeParse(migrated).success).toBe(true)
  })

  it("still removes a row using a retired provider id", () => {
    const retired = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      id: "read-frog-free-ai",
      enabled: true,
    }
    const migrated = migrate(configWithAssignments([retired], retired.id))
    expect(migrated.providersConfig).toEqual([])
    expectUnconfiguredAssignments(migrated)
  })

  it.each(["disabled-byok", "missing-provider", "byos"])(
    "still clears %s assignments without choosing a different provider",
    (providerId) => {
      const providers = [
        {
          ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
          id: "disabled-byok",
          name: "Disabled BYOK",
          enabled: false,
        },
        {
          ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
          id: "available-byok",
          name: "Available BYOK",
          enabled: true,
        },
        {
          ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
          id: "legacy-experimental",
          enabled: false,
        },
      ]
      const migrated = migrate(configWithAssignments(providers, providerId))
      expect(migrated.providersConfig).toEqual(providers)
      expectUnconfiguredAssignments(migrated)
      expect(configSchema.safeParse(migrated).success).toBe(true)
    },
  )

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
