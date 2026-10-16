// @vitest-environment jsdom
// The popup's translate button used to flip to "show original" as soon as it had
// handed the toggle to the background, whether or not any page manager heard it.
// With no receiver in the tab (opened before the install, context invalidated by
// an update or reload, a content script that failed to start) the popup then
// claimed a translation that never happened.
//
// The real popup button and the real background translation-signal handlers run
// here; only the transport is a double: what `browser.tabs.sendMessage` would do
// when the background talks to the tab (acknowledge, or reject like the browser).

import type { Config } from "@/types/config/config"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { browser, storage } from "#imports"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { translationMessage } from "@/entrypoints/background/translation-signal"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import { getPageTranslationOriginScope } from "@/utils/url"
import { isPageTranslatedAtom } from "../../atoms/auto-translate"
import TranslateButton from "../translate-button"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (msg: any) => any>(),
  // Popup → background messages answered by the real handlers; everything else is the
  // background talking to the tab (or to an open popup) and goes through `deliver`.
  backgroundHandled: new Set(["tryToSetEnablePageTranslationByTabId"]),
  sendMessage: vi.fn<(...args: any[]) => any>(),
  deliver: vi.fn<(...args: any[]) => any>(),
  openOptionsPage: vi.fn<(...args: any[]) => any>(),
  loggerWarn: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/message")>()),
  onMessage: (name: string, handler: (msg: any) => any) => {
    mocks.handlers.set(name, handler)
    return () => {}
  },
  sendMessage: mocks.sendMessage,
}))

vi.mock("@/utils/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/navigation")>()),
  openOptionsPage: mocks.openOptionsPage,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: vi.fn<(...args: any[]) => any>(),
    info: vi.fn<(...args: any[]) => any>(),
    warn: mocks.loggerWarn,
  },
}))

vi.mock("@/utils/host/translate/auto-translation", () => ({
  shouldEnableAutoTranslation: vi.fn<(...args: any[]) => any>().mockResolvedValue(false),
}))

vi.mock("@/entrypoints/background/iframe-injection", () => ({
  injectHostContentIntoTabIframes: vi.fn<(...args: any[]) => any>(),
  injectHostContentIntoCurrentTabIframesAfterNodeTranslation: vi.fn<(...args: any[]) => any>(),
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

const TAB_ID = 7
const TAB_URL = "https://example.com/articles/1"
const TAB_ORIGIN = getPageTranslationOriginScope(TAB_URL)
const PROVIDER_ID = "page-provider"
// For a page nothing could be reached on (no receiver, or the request failed).
const REFRESH_HINT = "popup.refreshNeeded"
// For a page that was still silent when the popup's deadline passed, which may only be slow.
const SLOW_HINT = "popup.noAnswerYet"

/** Neither hint is on screen: the attempt is pending or answered, or its hint was cleared. */
function expectNoHint() {
  expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
  expect(screen.queryByText(SLOW_HINT)).not.toBeInTheDocument()
}

// What @webext-core/messaging throws for a tab message nobody answered: it resolves the
// browser callback with undefined (without reading lastError) and turns that into this error.
const NO_RESPONSE = "No response"
const NO_RECEIVER = "Could not establish connection. Receiving end does not exist."
const PORT_CLOSED = "The message port closed before a response was received."
const CONTEXT_INVALIDATED = "Extension context invalidated."

const TAB_STATE_PREFIX = getTranslationStateKey(0).replace(/0$/, "")
const store = new Map<string, unknown>()
const tabState = () => store.get(getTranslationStateKey(TAB_ID))

async function renderButton({
  translated = false,
  edit,
  store: existingStore,
  strict = false,
}: {
  translated?: boolean
  edit?: (config: Config) => void
  // Mount again under a store that is still alive, as when only the React subtree below it is
  // re-created.
  store?: ReturnType<typeof createStore>
  strict?: boolean
} = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true },
  ]
  config.pageTranslation.providerId = PROVIDER_ID
  edit?.(config)
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const jotaiStore = existingStore ?? createStore()
  if (!existingStore) {
    jotaiStore.set(configAtom, config)
    jotaiStore.set(isPageTranslatedAtom, translated)
  }
  const tree = (
    <Provider store={jotaiStore}>
      <TooltipProvider>
        <TranslateButton />
      </TooltipProvider>
    </Provider>
  )
  render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  return jotaiStore
}

const translateButton = () => screen.getByRole("button", { name: /^popup\.translate/ })
const showOriginalButton = () => screen.getByRole("button", { name: /^popup\.showOriginal/ })

function askedTheTab(enabled: boolean) {
  return mocks.deliver.mock.calls.filter(
    ([name, data]) => name === "askManagerToTogglePageTranslation" && data.enabled === enabled,
  )
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.sendMessage.mockReset()
  mocks.deliver.mockReset().mockResolvedValue(undefined)
  mocks.openOptionsPage.mockReset()
  mocks.loggerWarn.mockReset()
  store.clear()

  mocks.sendMessage.mockImplementation((name: string, data: unknown, tabId?: number) => {
    if (mocks.backgroundHandled.has(name)) {
      const handler = mocks.handlers.get(name)
      if (!handler) throw new Error(`Expected a background handler for ${name}`)
      return Promise.resolve().then(() => handler({ data }))
    }
    return mocks.deliver(name, data, tabId)
  })

  browser.tabs.query = vi.fn<(...args: any[]) => any>().mockResolvedValue([{ id: TAB_ID }])
  vi.spyOn(browser.tabs, "get").mockResolvedValue({ id: TAB_ID, url: TAB_URL } as any)
  browser.tabs.onRemoved.addListener = vi.fn<(...args: any[]) => any>()
  browser.tabs.onActivated.addListener = vi.fn<(...args: any[]) => any>()
  browser.webNavigation.onCommitted.addListener = vi.fn<(...args: any[]) => any>()
  // Only the background's per-tab state is kept in memory; the config still comes from
  // the fake browser storage, as in the other popup tests.
  const realGetItem = storage.getItem.bind(storage)
  const isTabState = (key: string) => key.startsWith(TAB_STATE_PREFIX)
  vi.spyOn(storage, "getItem").mockImplementation(async (key: any, opts?: any) =>
    isTabState(key) ? store.get(key) : realGetItem(key, opts),
  )
  const realSetItem = storage.setItem.bind(storage)
  const realRemoveItem = storage.removeItem.bind(storage)
  vi.spyOn(storage, "setItem").mockImplementation(async (key: string, value: unknown) => {
    if (isTabState(key)) store.set(key, value)
    else await realSetItem(key as any, value as any)
  })
  vi.spyOn(storage, "removeItem").mockImplementation(async (key: string) => {
    if (isTabState(key)) store.delete(key)
    else await realRemoveItem(key as any)
  })

  translationMessage()
})

afterEach(() => {
  cleanup()
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

describe("popup translate button: the toggle reached a page manager", () => {
  it("flips to show original once a manager acknowledged the start", async () => {
    const jotaiStore = await renderButton()

    fireEvent.click(translateButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    expect(askedTheTab(true)).toHaveLength(1)
    expect(askedTheTab(true)[0]![2]).toEqual({ tabId: TAB_ID, frameId: 0 })
    expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
    expect(showOriginalButton()).toBeEnabled()
    // A start persists nothing on request: the manager records it itself once it activates.
    expect(tabState()).toBeUndefined()
  })

  it("flips back once a manager acknowledged the stop, and records the refusal", async () => {
    const jotaiStore = await renderButton({ translated: true })

    fireEvent.click(showOriginalButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false))
    expect(askedTheTab(false)).toHaveLength(1)
    expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
    expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: TAB_ORIGIN })
  })
})

describe("popup translate button: no page manager heard the toggle", () => {
  describe.each([
    ["no response from the tab (the messaging library's own error)", NO_RESPONSE],
    ["no receiver (tab opened before the install)", NO_RECEIVER],
    ["port closed without an answer", PORT_CLOSED],
    ["extension context invalidated (updated or reloaded)", CONTEXT_INVALIDATED],
  ])("%s", (_name, message) => {
    beforeEach(() => {
      mocks.deliver.mockImplementation((name: string) =>
        name === "askManagerToTogglePageTranslation"
          ? Promise.reject(new Error(message))
          : Promise.resolve(undefined),
      )
    })

    it("keeps Translate and shows the refresh hint, persisting no enabled state", async () => {
      const jotaiStore = await renderButton()

      fireEvent.click(translateButton())

      // The background has logged the undeliverable request: the attempt is over.
      await waitFor(() => expect(mocks.loggerWarn).toHaveBeenCalled())
      expect.soft(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
      await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
      expect(translateButton()).toBeEnabled()
      // Nothing claims the page is (or should be) translating.
      expect(tabState()).toBeUndefined()
      expect(mocks.loggerWarn).toHaveBeenCalled()
    })

    it("keeps Show original and shows the refresh hint; the refusal stays recorded", async () => {
      const jotaiStore = await renderButton({ translated: true })

      fireEvent.click(showOriginalButton())

      await waitFor(() => expect(mocks.loggerWarn).toHaveBeenCalled())
      expect.soft(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
      await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
      expect(showOriginalButton()).toBeEnabled()
      // What the background persists for a stop it could not deliver: the user's refusal,
      // written before delivery so a concurrent re-detection cannot switch the page back
      // on. A refresh then comes up untranslated, as the user asked.
      expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: TAB_ORIGIN })
    })
  })

  it("clears the hint and flips once a later attempt is acknowledged", async () => {
    mocks.deliver.mockRejectedValueOnce(new Error(NO_RECEIVER))
    const jotaiStore = await renderButton()

    fireEvent.click(translateButton())
    await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)

    mocks.deliver.mockResolvedValue(undefined)
    fireEvent.click(translateButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
  })

  it("shows the refresh hint, not the slow-page hint, when nothing could be reached", async () => {
    mocks.deliver.mockRejectedValue(new Error(NO_RECEIVER))
    const jotaiStore = await renderButton()

    fireEvent.click(translateButton())

    await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
    expect(screen.queryByText(SLOW_HINT)).not.toBeInTheDocument()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
  })

  it("treats an unreachable background the same way", async () => {
    mocks.sendMessage.mockRejectedValue(new Error(CONTEXT_INVALIDATED))
    const jotaiStore = await renderButton()

    fireEvent.click(translateButton())

    await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
  })

  it("ignores a second click while the first toggle is still waiting for its answer", async () => {
    let acknowledge!: () => void
    mocks.deliver.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        }),
    )
    const jotaiStore = await renderButton()

    fireEvent.click(translateButton())
    await waitFor(() => expect(askedTheTab(true)).toHaveLength(1))
    fireEvent.click(translateButton())
    await Promise.resolve()
    acknowledge()

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    expect(askedTheTab(true)).toHaveLength(1)
  })
})

describe("popup translate button: a toggle nobody answers", () => {
  // The messaging library has no timeout of its own, so a channel that stays open and never
  // replies would otherwise leave the button silently unusable. The popup bounds its own wait.
  const DEADLINE_MS = 5_000

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Every ask to the tab's manager waits for the test to answer it, in order. */
  function holdReplies() {
    const held: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    mocks.deliver.mockImplementation((name: string) => {
      if (name !== "askManagerToTogglePageTranslation") return Promise.resolve(undefined)
      return new Promise<void>((resolve, reject) => held.push({ resolve, reject }))
    })
    return held
  }

  const settle = (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it("shows the refresh hint once the deadline passes, and the button works again", async () => {
    const held = holdReplies()
    const jotaiStore = await renderButton()
    vi.useFakeTimers()

    fireEvent.click(translateButton())
    await settle()
    expect(askedTheTab(true)).toHaveLength(1)

    await settle(DEADLINE_MS - 1)
    expectNoHint()

    await settle(1)
    expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(translateButton()).toBeEnabled()

    // The guard is released: a second click sends a new request.
    fireEvent.click(translateButton())
    await settle()
    expect(askedTheTab(true)).toHaveLength(2)
    expect(held).toHaveLength(2)
  })

  it("says the page has not answered yet, not that it could not be reached", async () => {
    holdReplies()
    await renderButton()
    vi.useFakeTimers()

    fireEvent.click(translateButton())
    await settle(DEADLINE_MS)

    // A slow page may still translate moments later: the hint must not claim it is unreachable.
    expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()
    expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(SLOW_HINT)
  })

  it("ignores a late reply to the attempt it gave up on, while a newer attempt is waiting", async () => {
    const held = holdReplies()
    const jotaiStore = await renderButton()
    vi.useFakeTimers()

    fireEvent.click(translateButton())
    await settle(DEADLINE_MS)
    expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()
    fireEvent.click(translateButton())
    await settle()
    expect(held).toHaveLength(2)
    // A new attempt starts with a clean slate.
    expectNoHint()

    // The first attempt's reply finally arrives, successful: it changes nothing on screen.
    held[0]!.resolve()
    await settle()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expectNoHint()

    // The newer attempt's own reply is what counts.
    held[1]!.resolve()
    await settle()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
    expectNoHint()
  })

  it.each([
    [
      "acknowledged",
      (held: Array<{ resolve: () => void; reject: (e: Error) => void }>) => held[0]!.resolve(),
    ],
    [
      "rejected",
      (held: Array<{ resolve: () => void; reject: (e: Error) => void }>) =>
        held[0]!.reject(new Error(NO_RECEIVER)),
    ],
  ])(
    "a reply that comes %s after the deadline does not change the screen",
    async (_kind, reply) => {
      const held = holdReplies()
      const jotaiStore = await renderButton()
      vi.useFakeTimers()

      fireEvent.click(translateButton())
      await settle(DEADLINE_MS)
      expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()

      reply(held)
      await settle()

      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
      expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()
      expect(translateButton()).toBeEnabled()
    },
  )

  it("clears the hint when the next attempt starts, not when it ends", async () => {
    holdReplies()
    await renderButton()
    vi.useFakeTimers()
    fireEvent.click(translateButton())
    await settle(DEADLINE_MS)
    expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()

    fireEvent.click(translateButton())
    await settle()

    // The second request is still pending, and the old hint is already gone.
    expect(askedTheTab(true)).toHaveLength(2)
    expectNoHint()
  })

  it("a stop nobody answers also shows the hint, and the refusal stays recorded", async () => {
    holdReplies()
    const jotaiStore = await renderButton({ translated: true })
    vi.useFakeTimers()

    fireEvent.click(showOriginalButton())
    await settle(DEADLINE_MS)

    expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
    expect(showOriginalButton()).toBeEnabled()
    expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: TAB_ORIGIN })
  })

  it("an answer inside the deadline behaves as before, and the deadline never fires afterwards", async () => {
    const held = holdReplies()
    const jotaiStore = await renderButton()
    vi.useFakeTimers()
    const timersBefore = vi.getTimerCount()

    fireEvent.click(translateButton())
    await settle(1_000)
    // The attempt's own deadline is armed while it waits…
    expect(vi.getTimerCount()).toBeGreaterThan(timersBefore)
    held[0]!.resolve()
    await settle()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
    // …and disarmed once it is answered.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore)

    await settle(DEADLINE_MS * 2)
    expectNoHint()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
  })

  describe("when the popup's React tree unmounts while a toggle is waiting", () => {
    // Closing the real toolbar popup destroys the whole page, JavaScript included. What these cases
    // cover is the narrower thing a React unmount does: the component goes away while the store
    // above it (and the messaging callbacks it started) stay alive, as when a boundary re-keys its
    // children. `cleanup()` is the unmount.
    const unmount = () => cleanup()

    it("leaves no deadline timer armed", async () => {
      holdReplies()
      await renderButton()
      vi.useFakeTimers()
      const timersBefore = vi.getTimerCount()

      fireEvent.click(translateButton())
      await settle()
      expect(vi.getTimerCount()).toBeGreaterThan(timersBefore)

      unmount()

      expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore)
    })

    it.each([
      [
        "acknowledged",
        (held: Array<{ resolve: () => void; reject: (e: Error) => void }>) => held[0]!.resolve(),
      ],
      [
        "rejected",
        (held: Array<{ resolve: () => void; reject: (e: Error) => void }>) =>
          held[0]!.reject(new Error(NO_RECEIVER)),
      ],
    ])(
      "a reply that comes %s after the unmount, and the deadline passing, change nothing",
      async (_kind, reply) => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
        const held = holdReplies()
        const jotaiStore = await renderButton()
        vi.useFakeTimers()

        fireEvent.click(translateButton())
        await settle()
        expect(held).toHaveLength(1)
        unmount()

        // The five seconds go by with nobody left to show a hint, then the reply arrives.
        await settle(DEADLINE_MS * 2)
        reply(held)
        await settle()

        expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
        expect(consoleError).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it("a reply that comes inside the deadline but after the unmount does not flip the shared state", async () => {
      const held = holdReplies()
      const jotaiStore = await renderButton()
      vi.useFakeTimers()

      fireEvent.click(translateButton())
      await settle(1_000)
      unmount()
      held[0]!.resolve()
      await settle()

      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    })

    it("still disarms the newer attempt's deadline after an older attempt's late reply settled", async () => {
      const held = holdReplies()
      await renderButton()
      vi.useFakeTimers()
      const timersBefore = vi.getTimerCount()

      fireEvent.click(translateButton())
      await settle(DEADLINE_MS)
      fireEvent.click(translateButton())
      await settle()
      expect(held).toHaveLength(2)
      // The first attempt, given up on long ago, finishes now. It must not forget the second one's timer.
      held[0]!.reject(new Error(NO_RECEIVER))
      await settle()
      expect(vi.getTimerCount()).toBeGreaterThan(timersBefore)

      unmount()

      expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore)
    })

    it("sends nothing when the tree unmounts before the active tab is known", async () => {
      const held = holdReplies()
      const jotaiStore = await renderButton()
      vi.useFakeTimers()
      let tabKnown!: () => void
      browser.tabs.query = vi.fn<(...args: any[]) => any>().mockImplementation(
        () =>
          new Promise((resolve) => {
            tabKnown = () => resolve([{ id: TAB_ID }])
          }),
      )

      fireEvent.click(translateButton())
      await settle()
      unmount()
      tabKnown()
      await settle()

      expect(askedTheTab(true)).toHaveLength(0)
      expect(held).toHaveLength(0)
      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    })

    it("a button mounted afterwards works normally, and the old attempt's reply cannot answer for it", async () => {
      const held = holdReplies()
      const jotaiStore = await renderButton()
      vi.useFakeTimers()

      fireEvent.click(translateButton())
      await settle()
      unmount()

      await renderButton({ store: jotaiStore })
      expect(translateButton()).toBeEnabled()
      fireEvent.click(translateButton())
      await settle()
      expect(held).toHaveLength(2)

      // The first instance's reply comes while the new button's own request is still waiting.
      held[0]!.resolve()
      await settle()
      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
      expectNoHint()

      held[1]!.resolve()
      await settle()
      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
      expectNoHint()
      expect(vi.getTimerCount()).toBe(0)
    })

    it("a button mounted after a settled attempt and an unmount works normally", async () => {
      const held = holdReplies()
      const jotaiStore = await renderButton()
      vi.useFakeTimers()

      fireEvent.click(translateButton())
      await settle()
      held[0]!.resolve()
      await settle()
      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
      unmount()

      await renderButton({ store: jotaiStore })
      fireEvent.click(showOriginalButton())
      await settle()
      expect(held).toHaveLength(2)
      held[1]!.resolve()
      await settle()

      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
      expectNoHint()
    })

    describe("under StrictMode, which the popup uses and which runs a mount cleanup once", () => {
      it("still sends, waits and flips on an acknowledged answer", async () => {
        const held = holdReplies()
        const jotaiStore = await renderButton({ strict: true })
        vi.useFakeTimers()

        fireEvent.click(translateButton())
        await settle()
        expect(held).toHaveLength(1)
        held[0]!.resolve()
        await settle()

        expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true)
        expectNoHint()
      })

      it("still gives up after the deadline and allows another click", async () => {
        const held = holdReplies()
        await renderButton({ strict: true })
        vi.useFakeTimers()

        fireEvent.click(translateButton())
        await settle(DEADLINE_MS)
        expect(screen.getByText(SLOW_HINT)).toBeInTheDocument()

        fireEvent.click(translateButton())
        await settle()
        expect(held).toHaveLength(2)
      })
    })
  })
})

describe("popup translate button: provider guidance (#79) is unchanged", () => {
  it("stays disabled with the reason and sends nothing when no provider is chosen", async () => {
    const jotaiStore = await renderButton({
      edit: (config) => {
        config.pageTranslation.providerId = "unconfigured"
      },
    })

    expect(translateButton()).toBeDisabled()
    expect(translateButton()).toHaveAccessibleDescription("providerRequired.message")
    fireEvent.click(translateButton())
    await Promise.resolve()

    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
  })

  it("still opens the page translation provider row from the settings button", async () => {
    await renderButton({
      edit: (config) => {
        config.pageTranslation.providerId = "unconfigured"
      },
    })

    fireEvent.click(screen.getByRole("button", { name: "providerRequired.openSettings" }))

    expect(mocks.openOptionsPage).toHaveBeenCalledExactlyOnceWith({
      route: "/api-providers?section=feature-provider-pageTranslation",
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
})
