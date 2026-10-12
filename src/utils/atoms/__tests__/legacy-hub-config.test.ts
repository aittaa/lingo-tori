// @vitest-environment jsdom
import { createStore } from "jotai"
import { afterEach, describe, expect, it } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { configAtom, writeConfigAtom } from "../config"
import { storageAdapter } from "../storage-adapter"

afterEach(() => fakeBrowser.reset())

function savedConfig() {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), apiKey: "synthetic-saved-key" },
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.deepl), apiKey: "synthetic-translator-key" },
    structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
  ]
  config.pageTranslation.providerId = "openai-default"
  config.selectionToolbar.features.translate.providerId = "byos-default"
  config.videoSubtitles.providerId = "openai-default"
  config.selectionToolbar.builtInActions.dictionary.providerId = "openai-default"
  config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = "byos-default"
  config.translationHub = {
    shortcut: "Alt+Shift+K",
    selectedProviderIds: ["openai-default", "deepl-default", "byos-default", "removed-provider"],
    sourceCode: "spa",
    targetCode: "kor",
    promptId: "saved-hub-prompt",
  }
  return config
}

describe("retired Hub storage compatibility", () => {
  it.each([false, true])(
    "preserves legacy preferences, keys and feature assignments after a settings write (empty selection %s)",
    async (emptySelection) => {
      const saved = savedConfig()
      if (emptySelection) saved.translationHub.selectedProviderIds = []
      await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, saved)
      const current = await storageAdapter.get(CONFIG_STORAGE_KEY, DEFAULT_CONFIG, configSchema)
      expect(current).toEqual(saved)

      const store = createStore()
      store.set(configAtom, current)
      await store.set(writeConfigAtom, { uiLanguage: "ko" })

      const persisted = await storage.getItem(`local:${CONFIG_STORAGE_KEY}`)
      expect(persisted).toEqual({ ...saved, uiLanguage: "ko" })
      expect(store.get(configAtom)).toEqual(persisted)
    },
  )

  it("accepts older configs without Hub preferences without resetting retained settings", () => {
    const { translationHub: _legacy, ...older } = savedConfig()
    const parsed = configSchema.parse(older)
    // configSchema keeps a missing pre-migration prompt unset so v101-to-v102
    // can copy the saved page prompt. DEFAULT_CONFIG's prompt is for fresh installs.
    expect(parsed).toEqual({
      ...older,
      translationHub: { ...DEFAULT_CONFIG.translationHub, promptId: null },
    })
  })
})
