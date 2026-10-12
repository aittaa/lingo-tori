import type { Config } from "@/types/config/config"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { configSchema } from "@/types/config/config"
import { getUiLocale, i18n, initI18n, setUiLanguage } from "../index"
import { resolveUiLocale } from "../locale-map"
import { SUPPORTED_UI_LOCALES } from "../locales"

// Opt this suite into the real facade; the general setup stubs it for UI tests.
// WxtVitest does not include the Vite YAML plugin, so parse the actual catalogues
// with that plugin's installed parser and keep the production resource conversion.
vi.unmock("@/utils/i18n")
const { browserLanguage, loadCatalogue } = vi.hoisted(() => ({
  browserLanguage: vi.fn<() => string>(() => "en-US"),
  loadCatalogue: async (locale: string) => {
    const { readFileSync } = await import("node:fs")
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    const { load } = createRequire(require.resolve("@modyfi/vite-plugin-yaml"))("js-yaml")
    return {
      default: load(
        readFileSync(new URL(`../../../locales/${locale}.yml`, import.meta.url), "utf8"),
      ),
    }
  },
}))
vi.mock("@/locales/az.yml", () => loadCatalogue("az"))
vi.mock("@/locales/en.yml", () => loadCatalogue("en"))
vi.mock("@/locales/es.yml", () => loadCatalogue("es"))
vi.mock("@/locales/ja.yml", () => loadCatalogue("ja"))
vi.mock("@/locales/ko.yml", () => loadCatalogue("ko"))
vi.mock("@/locales/ru.yml", () => loadCatalogue("ru"))
vi.mock("@/locales/tr.yml", () => loadCatalogue("tr"))
vi.mock("@/locales/vi.yml", () => loadCatalogue("vi"))
vi.mock("@/locales/zh-CN.yml", () => loadCatalogue("zh-CN"))
vi.mock("@/locales/zh-TW.yml", () => loadCatalogue("zh-TW"))
vi.mock("#imports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#imports")>()
  return {
    ...actual,
    browser: {
      ...actual.browser,
      i18n: { ...actual.browser.i18n, getUILanguage: browserLanguage },
    },
  }
})

let defaultConfig: Config
beforeAll(async () => {
  await initI18n("en")
  defaultConfig = (await import("@/utils/constants/config")).DEFAULT_CONFIG
})

afterEach(async () => {
  browserLanguage.mockReset().mockReturnValue("en-US")
  await initI18n("en")
})

describe("restored interface language selection", () => {
  it.each(SUPPORTED_UI_LOCALES)(
    "persists %s and switches the runtime resources",
    async (locale) => {
      const config = configSchema.parse({ ...defaultConfig, uiLanguage: locale })
      expect(config.uiLanguage).toBe(locale)
      expect(config.language).toEqual(defaultConfig.language)
      expect(config.providersConfig).toEqual(defaultConfig.providersConfig)
      await initI18n("en")
      await setUiLanguage(config.uiLanguage)
      expect(getUiLocale()).toBe(locale)
      expect(i18n.t("options.apiProviders.badges.featureCount", [3])).toContain("3")
      expect(i18n.t("contextMenu.translateSelection")).toContain("%s")
    },
  )

  it.each([
    ["es-MX", "es"],
    ["ru-RU", "ru"],
    ["az-AZ", "az"],
    ["tr-TR", "tr"],
    ["vi-VN", "vi"],
    ["zh", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["ZH_tw", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-Hant-CN", "zh-TW"],
    ["pt-BR", "en"],
  ])("resolves Auto for browser %s to %s", async (language, expected) => {
    browserLanguage.mockReturnValue(language)
    expect(resolveUiLocale("auto")).toBe(expected)
    await initI18n("auto")
    expect(getUiLocale()).toBe(expected)
  })

  it("uses English when browser language access fails", () => {
    browserLanguage.mockImplementation(() => {
      throw new Error("unavailable")
    })
    expect(resolveUiLocale("auto")).toBe("en")
  })

  it("keeps the default and rejects unknown persisted languages", () => {
    const { uiLanguage: _oldLanguage, ...withoutLanguage } = defaultConfig
    expect(configSchema.parse(withoutLanguage).uiLanguage).toBe("auto")
    expect(configSchema.safeParse({ ...defaultConfig, uiLanguage: "ar" }).success).toBe(false)
  })

  it.each(["az", "es", "ru", "tr", "vi", "zh-CN", "zh-TW"] as const)(
    "%s falls back to current English copy and the Korean dictionary example",
    async (locale) => {
      await initI18n("en")
      const description = i18n.t("extDescription")
      const newCopy = i18n.t("subtitles.actions.copyPreparing")
      const prompt = i18n.t(
        "options.selectionToolbar.customActions.templates.dictionary.systemPrompt",
      )
      await setUiLanguage(locale)
      expect(i18n.t("extDescription")).toBe(description)
      expect(i18n.t("subtitles.actions.copyPreparing")).toBe(newCopy)
      expect(
        i18n.t("options.selectionToolbar.customActions.templates.dictionary.systemPrompt"),
      ).toBe(prompt)
      expect(prompt).toContain("Target language=Korean")
    },
  )
})
