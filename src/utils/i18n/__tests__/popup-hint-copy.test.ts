// The popup's two delivery hints and the toast region label, selected by key in each interface
// language. "popup.refreshNeeded" is for a page nothing could be reached on (no receiver, or the
// request failed); "popup.noAnswerYet" is for a page that is still silent when the popup's deadline
// passes, which may only be slow, so it does not claim the page is unreachable. Copy only: the
// restored locales fall back to English for the new keys (recorded in the coverage inventory).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { i18n, initI18n, setUiLanguage } from "../index"

// Opt in to the real facade; the general setup stubs it for UI tests.
vi.unmock("@/utils/i18n")
const { loadCatalogue } = vi.hoisted(() => ({
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

const originalBrowserLanguage = fakeBrowser.i18n.getUILanguage

beforeAll(async () => {
  fakeBrowser.i18n.getUILanguage = () => "en-US"
  await initI18n("en")
})

afterEach(async () => {
  await setUiLanguage("en")
})

afterAll(() => {
  fakeBrowser.i18n.getUILanguage = originalBrowserLanguage
})

const EN_NO_RECEIVER = "Couldn't reach this page. Refresh it, then try again."
const EN_NO_ANSWER = "This page hasn't answered yet. If nothing changes, refresh it and try again."

describe("the popup's delivery hints", () => {
  it("keeps the unreachable-page hint as it was", async () => {
    expect(i18n.t("popup.refreshNeeded")).toBe(EN_NO_RECEIVER)
  })

  it("has a separate English hint for a page that has not answered yet", () => {
    expect(i18n.t("popup.noAnswerYet")).toBe(EN_NO_ANSWER)
  })

  it.each(["ko", "ja"] as const)(
    "says the two things differently in %s, and neither in English",
    async (locale) => {
      await setUiLanguage(locale)

      const unreachable = i18n.t("popup.refreshNeeded")
      const notAnswered = i18n.t("popup.noAnswerYet")

      expect(notAnswered).not.toBe("")
      expect(notAnswered).not.toBe(EN_NO_ANSWER)
      expect(notAnswered).not.toBe(unreachable)
      expect(unreachable).not.toBe(EN_NO_RECEIVER)
    },
  )
})

describe("the toast region label", () => {
  it.each([
    ["en", "Notifications"],
    ["ko", "알림"],
    ["ja", "通知"],
  ] as const)("is %s: %s", async (locale, label) => {
    await setUiLanguage(locale)

    expect(i18n.t("toast.region")).toBe(label)
  })
})
