// @vitest-environment jsdom
// Base UI names its toast viewport "Notifications" itself, in English, whatever the interface
// language is. The popup mounts two viewports (the corner toasts and the anchored ones), so a screen
// reader in the Korean or Japanese popup met two English regions among otherwise translated labels.
// The app now passes the label through the viewport's own aria-label.
//
// The real i18n facade runs here, over the real EN / KO / JA catalogues; the general test setup stubs
// the facade (it returns keys), so this suite opts out of that stub. Under jsdom Vitest does not apply
// module mocks to the .yml imports, so the module that gathers them is replaced instead, with the same
// resource shape built from the parsed catalogue files.

import { cleanup, render, screen } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { AnchoredToastProvider, ToastProvider } from "@/components/ui/base-ui/toast"
import { initI18n, setUiLanguage } from "@/utils/i18n"

vi.unmock("@/utils/i18n")
vi.mock("@/utils/i18n/resources", async () => {
  const { readFileSync } = await import("node:fs")
  const { createRequire } = await import("node:module")
  const { DEFAULT_UI_LOCALE, SUPPORTED_UI_LOCALES } = await import("@/utils/i18n/locales")
  const require = createRequire(import.meta.url)
  const { load } = createRequire(require.resolve("@modyfi/vite-plugin-yaml"))("js-yaml")
  // Under jsdom import.meta.url is not a file URL, so the catalogues are found from the repo root.
  const catalogue = (locale: string) =>
    load(readFileSync(`${process.cwd()}/src/locales/${locale}.yml`, "utf8"))
  return {
    DEFAULT_UI_LOCALE,
    SUPPORTED_UI_LOCALES,
    resources: {
      en: { translation: catalogue("en") },
      ja: { translation: catalogue("ja") },
      ko: { translation: catalogue("ko") },
    },
  }
})

const originalBrowserLanguage = fakeBrowser.i18n.getUILanguage

beforeAll(async () => {
  fakeBrowser.i18n.getUILanguage = () => "en-US"
  await initI18n("en")
})

afterEach(async () => {
  cleanup()
  await setUiLanguage("en")
})

afterAll(() => {
  fakeBrowser.i18n.getUILanguage = originalBrowserLanguage
})

/** The popup's arrangement: the corner toasts and the anchored ones, both mounted at once. */
function renderPopupToasts() {
  render(
    <ToastProvider>
      <AnchoredToastProvider />
    </ToastProvider>,
  )
}

describe("the toast regions' accessible name", () => {
  it.each([
    ["en", "Notifications"],
    ["ko", "알림"],
    ["ja", "通知"],
  ] as const)("is in the interface language: %s", async (locale, name) => {
    await setUiLanguage(locale)

    renderPopupToasts()

    // Both viewports, and none left with the library's English default.
    expect(screen.getAllByRole("region", { name })).toHaveLength(2)
    expect(
      screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")),
    ).toEqual([name, name])
  })

  it("does not name either region 'Notifications' in Korean or Japanese", async () => {
    for (const locale of ["ko", "ja"] as const) {
      await setUiLanguage(locale)
      renderPopupToasts()
      expect(screen.queryByRole("region", { name: "Notifications" })).not.toBeInTheDocument()
      cleanup()
    }
  })

  it("lets a caller's own aria-label on the viewport win", () => {
    render(<ToastProvider viewportProps={{ "aria-label": "Custom label" }} />)

    expect(screen.getByRole("region", { name: "Custom label" })).toBeInTheDocument()
  })
})
