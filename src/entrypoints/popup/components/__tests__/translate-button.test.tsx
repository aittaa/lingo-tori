// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { browser } from "#imports"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { isPageTranslatedAtom } from "../../atoms/auto-translate"
import TranslateButton from "../translate-button"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
  openOptionsPage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/message")>()),
  sendMessage: mocks.sendMessage,
}))

vi.mock("@/utils/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/navigation")>()),
  openOptionsPage: mocks.openOptionsPage,
}))

vi.mock("../../atoms/auto-translate", async () => {
  const { atom } = await import("jotai")
  return { isPageTranslatedAtom: atom(false) }
})

vi.mock("../../atoms/ignore", async () => {
  const { atom } = await import("jotai")
  return { isIgnoreTabAtom: atom(false) }
})

vi.mock("../../atoms/site-control", async () => {
  const { atom } = await import("jotai")
  return { isCurrentSiteInBlacklistAtom: atom(false), isCurrentSiteInWhitelistAtom: atom(false) }
})

const PROVIDER_ID = "page-provider"

// The stored config too: the config atom reloads it once mounted.
async function renderButton({
  edit,
  translated = false,
}: { edit?: (config: Config) => void; translated?: boolean } = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true },
  ]
  // Only page translation gets a provider; the selection toolbar and subtitles stay unassigned,
  // which must not hold the popup button back.
  config.pageTranslation.providerId = PROVIDER_ID
  edit?.(config)
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  store.set(isPageTranslatedAtom, translated)
  render(
    <Provider store={store}>
      <TooltipProvider>
        <TranslateButton />
      </TooltipProvider>
    </Provider>,
  )
  return store
}

// The shortcut hint is part of the button, so the name only starts with the label.
const translateButton = () => screen.getByRole("button", { name: /^popup\.translate/ })
const showOriginalButton = () => screen.getByRole("button", { name: /^popup\.showOriginal/ })

describe("popup translate button", () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset()
    mocks.openOptionsPage.mockReset()
    browser.tabs.query = vi.fn<(...args: any[]) => any>().mockResolvedValue([{ id: 7 }])
  })

  afterEach(() => {
    cleanup()
    fakeBrowser.reset()
  })

  it("starts a translation on click when page translation has a provider", async () => {
    const store = await renderButton()

    expect(translateButton()).toBeEnabled()
    fireEvent.click(translateButton())

    await waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "tryToSetEnablePageTranslationByTabId",
        expect.objectContaining({ tabId: 7, enabled: true }),
      )
    })
    expect(store.get(isPageTranslatedAtom)).toBe(true)
    expect(screen.queryByText("providerRequired.message")).not.toBeInTheDocument()
  })

  it.each([
    [
      "unassigned",
      (config: Config) => {
        config.pageTranslation.providerId = "unconfigured"
      },
    ],
    [
      "deleted",
      (config: Config) => {
        config.providersConfig = []
      },
    ],
    [
      "disabled",
      (config: Config) => {
        config.providersConfig[0]!.enabled = false
      },
    ],
  ])("is disabled and says why when the provider is %s", async (_case, edit) => {
    const store = await renderButton({ edit })

    expect(translateButton()).toBeDisabled()
    expect(translateButton()).toHaveAccessibleDescription("providerRequired.message")

    fireEvent.click(translateButton())
    await Promise.resolve()

    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(store.get(isPageTranslatedAtom)).toBe(false)
  })

  it("does not take another feature's provider for page translation's", async () => {
    await renderButton({
      edit: (config) => {
        config.pageTranslation.providerId = "unconfigured"
        config.selectionToolbar.features.translate.providerId = PROVIDER_ID
        config.videoSubtitles.providerId = PROVIDER_ID
      },
    })

    expect(translateButton()).toBeDisabled()
  })

  it("links to the page translation row, keyboard-reachable and described", async () => {
    await renderButton({
      edit: (config) => {
        config.pageTranslation.providerId = "unconfigured"
      },
    })

    const settings = screen.getByRole("button", { name: "providerRequired.openSettings" })
    expect(settings).toBeEnabled()
    expect(settings).toHaveAccessibleDescription("providerRequired.message")
    settings.focus()
    expect(settings).toHaveFocus()
    translateButton().focus()
    expect(translateButton()).not.toHaveFocus()

    fireEvent.click(settings)

    expect(mocks.openOptionsPage).toHaveBeenCalledExactlyOnceWith({
      route: "/api-providers?section=feature-provider-pageTranslation",
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("opens the provider hint on the disabled button's hover wrapper", async () => {
    await renderButton({
      edit: (config) => {
        config.pageTranslation.providerId = "unconfigured"
      },
    })
    const wrapper = translateButton().closest("[data-slot=tooltip-trigger]")!
    fireEvent.mouseEnter(wrapper)
    fireEvent.mouseMove(wrapper, { clientX: 1, clientY: 1 })

    await waitFor(() => {
      expect(document.querySelector("[data-slot=tooltip-content][data-open]")).toHaveTextContent(
        "providerRequired.message",
      )
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("still shows the original without a provider", async () => {
    const store = await renderButton({
      translated: true,
      edit: (config) => {
        config.providersConfig = []
      },
    })

    expect(showOriginalButton()).toBeEnabled()
    expect(screen.queryByText("providerRequired.message")).not.toBeInTheDocument()

    fireEvent.click(showOriginalButton())

    await waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "tryToSetEnablePageTranslationByTabId",
        expect.objectContaining({ tabId: 7, enabled: false }),
      )
    })
    expect(store.get(isPageTranslatedAtom)).toBe(false)
  })
})
