// @vitest-environment jsdom
// The popup shows the banner when the stored config cannot be used, and its button opens the
// settings page at the recovery notice. The popup's own controls are stood in for (each needs a
// page and a tab); the banner, the health atoms and the stored config are real.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  corruptConfig,
  CURRENT_META,
  resetStorage,
  seedPrimary,
  settle,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"

const openOptionsPage = vi.hoisted(() => vi.fn<(options?: { route?: string }) => Promise<void>>())

vi.mock("@/utils/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/navigation")>()),
  openOptionsPage,
}))
vi.mock("../components/ai-smart-context", () => ({ AISmartContext: () => null }))
vi.mock("../components/always-translate", () => ({ AlwaysTranslate: () => null }))
vi.mock("../components/foreign-video-auto-translate", () => ({
  ForeignVideoAutoTranslate: () => null,
}))
vi.mock("../components/language-options-selector", () => ({ default: () => null }))
vi.mock("../components/more-menu", () => ({ MoreMenu: () => null }))
vi.mock("../components/node-translation-hotkey-selector", () => ({ default: () => null }))
vi.mock("../components/providers-field", () => ({ default: () => null }))
vi.mock("../components/site-control-toggle", () => ({ SiteControlToggle: () => null }))
vi.mock("../components/translate-button", () => ({ default: () => null }))
vi.mock("../components/translate-prompt-selector", () => ({ default: () => null }))
vi.mock("../components/translation-mode-selector", () => ({ default: () => null }))

beforeEach(() => {
  resetStorage()
  openOptionsPage.mockReset()
  openOptionsPage.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

async function renderPopup() {
  const { default: App } = await import("../app")
  render(
    <Provider store={createStore()}>
      <App />
    </Provider>,
  )
}

describe("the popup", () => {
  it("tells the user the stored config cannot be read, and opens the recovery notice", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    await renderPopup()
    await waitFor(() => screen.getByText("configHealth.unusable.title"))
    fireEvent.click(screen.getByText("configHealth.unusable.action"))

    expect(openOptionsPage).toHaveBeenCalledWith({ route: "/preference?section=recovery-notice" })
  })

  it("shows no banner when the stored config can be used", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    await renderPopup()
    await settle()

    expect(screen.queryByTestId("config-health-banner")).not.toBeInTheDocument()
  })
})
