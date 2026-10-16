// @vitest-environment jsdom
// R2-FUX-02. The popup used to treat "a page manager received the toggle" as "the page is
// translating": the host listener hands the start over with `void manager.start()` and answers at
// once, the background reports `delivered: true`, and the popup flips to "Show original". The
// manager's own precheck can still refuse that start (same source and target language, a provider
// that is gone or has no key, an unavailable provider, an OFF that cancelled it first), so the
// button could claim a translation that never began while the page showed only the manager's notice.
//
// What is pinned here: the popup reflects the manager's accepted / rejected answer. A start that is
// accepted (the precheck passed; the page walk may still be running) flips the button as before; a
// refused one leaves "Translate", shows no generic refresh hint over the manager's own notice, and
// leaves the page and the stored state alone. The existing popup contract is unchanged: no receiver,
// the 5 s deadline, a late acknowledgement, a stop and its stored refusal.
//
// The real popup button, the real background translation-signal handlers, the real host runtime and
// the real PageTranslationManager run here through an in-memory message bus. Only the transport, the
// stored config and tab state, the provider availability, and the DOM work the manager would start
// after it has accepted a start (walk, title request, observers) are test doubles.
//
// The bus knows frames, as the browser does: a message to a tab reaches the listeners of every frame
// and the first reply wins, a message to one frame reaches only that frame (and fails when it has no
// receiver). The page's own host runtime is the top frame; `addSubframe` adds the host listeners of
// another frame, backed by a real manager of its own. The last describe pins that only the top
// frame's answer decides what the popup shows.

import type { ContentScriptContext } from "#imports"
import type { Config } from "@/types/config/config"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { browser, storage } from "#imports"
import { toastManager } from "@/components/ui/base-ui/toast"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { translationMessage } from "@/entrypoints/background/translation-signal"
import { bootstrapHostContent } from "@/entrypoints/host.content/runtime"
import { PageTranslationManager } from "@/entrypoints/host.content/translation-control/page-translation"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import {
  endPageTranslationSession,
  getPageTranslationSessionId,
} from "@/utils/host/translate/translation-session"
import { getPageTranslationOriginScope } from "@/utils/url"
import { isPageTranslatedAtom } from "../../atoms/auto-translate"
import TranslateButton from "../translate-button"

const h = vi.hoisted(() => {
  type Handler = (msg: any) => any
  // The top frame's listeners (and, for messages to the background, the background's).
  const handlers = new Map<string, Handler>()
  // The host listeners of the other frames, by frame id.
  const subframes = new Map<number, Map<string, Handler>>()
  // Which frame's listener is running right now, so a shared double can tell the frames apart.
  const running = { frame: 0 }
  const sent: Array<{ name: string; data: any; tabId?: number; frameId?: number }> = []
  // Messages sent to the background: the popup's toggle and what a content script reports. Every
  // other message goes the other way, from the background to the tab.
  const backgroundBound = new Set([
    "tryToSetEnablePageTranslationByTabId",
    "tryToSetEnablePageTranslationOnContentScript",
    "setAndNotifyPageTranslationStateChangedByManager",
    "getEnablePageTranslationFromContentScript",
    "reportDetectedPageLanguage",
    "cancelPageTranslationRequests",
  ])
  const transport = {
    // false: no content script in the tab (opened before the install, context invalidated).
    hostPresent: true,
    // true: the tab's answer is produced at once but handed back only when the test says so.
    holdTabReplies: false,
    heldTabReplies: [] as Array<() => void>,
  }
  const NO_RECEIVER = "Could not establish connection. Receiving end does not exist."
  function sendMessage(
    name: string,
    data?: any,
    target?: number | { tabId: number; frameId?: number },
  ): Promise<any> {
    const tabId = typeof target === "object" ? target.tabId : target
    const frameId = typeof target === "object" ? target.frameId : undefined
    sent.push({ name, data, tabId, frameId })
    const toTab = !backgroundBound.has(name) && target !== undefined
    if (toTab && !transport.hostPresent) {
      return Promise.reject(new Error(NO_RECEIVER))
    }
    // Who hears it: a message to the tab reaches every frame that listens; one to a frame, that frame.
    const listeners: Array<{ frame: number; handler: Handler }> = []
    const topHandler = handlers.get(name)
    if (topHandler && (frameId === undefined || frameId === 0)) {
      listeners.push({ frame: 0, handler: topHandler })
    }
    for (const [frame, frameHandlers] of subframes) {
      const handler = frameHandlers.get(name)
      if (handler && toTab && (frameId === undefined || frameId === frame)) {
        listeners.push({ frame, handler })
      }
    }
    if (listeners.length === 0) {
      return toTab && frameId !== undefined
        ? Promise.reject(new Error(NO_RECEIVER))
        : Promise.resolve(undefined)
    }
    const msg = backgroundBound.has(name)
      ? { data, sender: { tab: { id: 7, url: window.location.href }, frameId: 0 } }
      : { data }
    const answers = listeners.map(({ frame, handler }) =>
      Promise.resolve().then(() => {
        running.frame = frame
        try {
          return handler(msg)
        } finally {
          running.frame = 0
        }
      }),
    )
    // The first reply wins, as in the browser; with one listener that is its reply.
    const result = answers.length === 1 ? answers[0]! : Promise.race(answers)
    if (toTab && transport.holdTabReplies) {
      return new Promise((resolve, reject) => {
        transport.heldTabReplies.push(() => result.then(resolve, reject))
      })
    }
    return result
  }
  function onMessage(name: string, handler: Handler) {
    handlers.set(name, handler)
    return () => {
      if (handlers.get(name) === handler) handlers.delete(name)
    }
  }
  return {
    handlers,
    subframes,
    running,
    sent,
    transport,
    sendMessage,
    onMessage,
    mockGetLocalConfig: vi.fn<(...args: any[]) => any>(),
    mockCheckProviderAvailability: vi.fn<(...args: any[]) => any>(),
    mockWalkAndLabelElementChunked: vi.fn<(...args: any[]) => any>(),
    mockTranslateTextForPageTitle: vi.fn<(...args: any[]) => any>(),
    intersectionObservers: [] as unknown[],
  }
})

vi.mock("@/utils/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/message")>()),
  onMessage: h.onMessage,
  sendMessage: h.sendMessage,
}))

vi.mock("@/utils/config/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/config/storage")>()),
  getLocalConfig: h.mockGetLocalConfig,
}))

vi.mock("@/utils/providers/provider-ref", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/providers/provider-ref")>()),
  checkProviderAvailability: h.mockCheckProviderAvailability,
}))

vi.mock("@/utils/host/dom/traversal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/dom/traversal")>()),
  walkAndLabelElement: vi.fn<(...args: any[]) => any>(),
  walkAndLabelElementChunked: h.mockWalkAndLabelElementChunked,
}))

vi.mock("@/utils/host/dom/find", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/dom/find")>()),
  deepQueryTopLevelSelector: vi.fn<(...args: any[]) => any>().mockReturnValue([]),
}))

vi.mock("@/utils/host/translate/node-manipulation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/translate/node-manipulation")>()),
  removeAllTranslatedWrapperNodes: vi.fn<(...args: any[]) => any>(),
  translateWalkedElement: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/translate-variants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/translate/translate-variants")>()),
  translateTextForPageTitle: h.mockTranslateTextForPageTitle,
}))

vi.mock("@/utils/host/translate/auto-translation", () => ({
  shouldEnableAutoTranslation: vi.fn<(...args: any[]) => any>().mockResolvedValue(false),
}))

vi.mock("@/utils/content/page-language", () => ({
  detectPageLanguageLightweight: vi
    .fn<(...args: any[]) => any>()
    .mockResolvedValue({ detectedCodeOrUnd: "fra" }),
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: vi.fn<(...args: any[]) => any>(),
    info: vi.fn<(...args: any[]) => any>(),
    warn: vi.fn<(...args: any[]) => any>(),
  },
}))

vi.mock("@/utils/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/navigation")>()),
  openOptionsPage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/entrypoints/background/iframe-injection", () => ({
  injectHostContentIntoTabIframes: vi.fn<(...args: any[]) => any>(),
  injectHostContentIntoCurrentTabIframesAfterNodeTranslation: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/entrypoints/host.content/listen", () => ({ setupUrlChangeListener: () => () => {} }))
vi.mock("@/entrypoints/host.content/mount-host-toast", () => ({ mountHostToast: () => () => {} }))
vi.mock("@/entrypoints/host.content/translation-control/bind-translation-shortcut", () => ({
  bindTranslationShortcutKey: async () => () => {},
}))
vi.mock("@/entrypoints/host.content/translation-control/bind-translation-mode-shortcut", () => ({
  bindTranslationModeShortcutKey: async () => () => {},
}))
vi.mock("@/entrypoints/host.content/translation-control/node-translation", () => ({
  registerNodeTranslationTriggers: () => () => {},
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

class MockIntersectionObserver {
  constructor() {
    h.intersectionObservers.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const TAB_ID = 7
const PAGE_URL = window.location.href
const PAGE_ORIGIN = getPageTranslationOriginScope(PAGE_URL)
const PROVIDER_ID = "page-provider"
const REFRESH_HINT = "popup.refreshNeeded"
const NO_ANSWER_HINT = "popup.noAnswerYet"
const SAME_LANGUAGE_NOTICE = "translation.sameLanguage"
const NO_KEY_NOTICE = "noAPIKeyConfig.warning"
const PROVIDER_REQUIRED_NOTICE = "providerRequired.message"
const DEADLINE_MS = 5_000

// The two hints are different states: the refresh hint is for a page nobody answered for (no
// receiver, or a toggle that failed), the other one for a page that is only slow to answer. A start
// that was answered, or has not run out of time yet, shows neither.
function expectNoHint() {
  expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
  expect(screen.queryByText(NO_ANSWER_HINT)).not.toBeInTheDocument()
}

function makeConfig({
  sameLanguage = false,
  apiKey = "test-key",
  providerId = PROVIDER_ID,
}: { sameLanguage?: boolean; apiKey?: string; providerId?: string } = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      id: PROVIDER_ID,
      enabled: true,
      apiKey,
    },
  ]
  config.pageTranslation.providerId = providerId
  config.language.sourceCode = "eng"
  config.language.targetCode = sameLanguage ? "eng" : "kor"
  return config
}

/** What the page's manager reads when it validates a start (the stored config). */
const hostSide = {
  config: makeConfig(),
  configGate: null as Deferred<Config> | null,
  // The same reads in a subframe's manager, which has its own page and its own timing.
  subframeConfig: makeConfig(),
  subframeConfigGate: null as Deferred<Config> | null,
}

// Only the background's per-tab state is kept in memory; the popup's config still comes from the fake
// browser storage, as in the other popup tests.
const TAB_STATE_PREFIX = getTranslationStateKey(0).replace(/0$/, "")
const memory = new Map<string, unknown>()
const tabState = () => memory.get(getTranslationStateKey(TAB_ID))
const walkGate = { held: null as Deferred<unknown> | null }

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let invalidate: (() => void) | undefined
async function bootstrapHost(): Promise<void> {
  const callbacks: Array<() => void> = []
  const ctx = {
    onInvalidated: (cb: () => void) => callbacks.push(cb),
  } as unknown as ContentScriptContext
  invalidate = () => callbacks.forEach((cb) => cb())
  await bootstrapHostContent(ctx, null)
  await flush()
}

/** The popup, rendered over the popup's own copy of the config (what it knew when it opened). */
async function renderPopup({ translated = false, popupConfig = makeConfig() } = {}) {
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: popupConfig })
  const jotaiStore = createStore()
  jotaiStore.set(configAtom, popupConfig)
  jotaiStore.set(isPageTranslatedAtom, translated)
  render(
    <Provider store={jotaiStore}>
      <TooltipProvider>
        <TranslateButton />
      </TooltipProvider>
    </Provider>,
  )
  return jotaiStore
}
const translateButton = () => screen.getByRole("button", { name: /^popup\.translate/ })
const showOriginalButton = () => screen.getByRole("button", { name: /^popup\.showOriginal/ })

const notices = () =>
  vi.mocked(toastManager.add).mock.calls.map(([toast]) => (toast as { title?: string }).title)
const activations = () =>
  h.sent.filter(
    (m) => m.name === "setAndNotifyPageTranslationStateChangedByManager" && m.data.enabled === true,
  )
const askedTheTab = (enabled: boolean) =>
  h.sent.filter((m) => m.name === "askManagerToTogglePageTranslation" && m.data.enabled === enabled)

/** Nothing of a page translation started: the manager never activated. */
function expectPageUntouched(): void {
  expect.soft(activations()).toHaveLength(0)
  expect.soft(getPageTranslationSessionId()).toBeNull()
  expect.soft(h.intersectionObservers).toHaveLength(0)
  expect.soft(h.mockWalkAndLabelElementChunked).not.toHaveBeenCalled()
  expect.soft(tabState()).toBeUndefined()
}

beforeEach(async () => {
  h.handlers.clear()
  h.sent.length = 0
  h.transport.hostPresent = true
  h.transport.holdTabReplies = false
  h.transport.heldTabReplies.length = 0
  h.intersectionObservers.length = 0
  memory.clear()
  hostSide.config = makeConfig()
  hostSide.configGate = null
  hostSide.subframeConfig = makeConfig()
  hostSide.subframeConfigGate = null
  h.subframes.clear()
  walkGate.held = null
  vi.clearAllMocks()

  document.head.innerHTML = ""
  document.body.innerHTML = "<main>Article body</main>"
  document.title = "Original Title"
  delete window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)

  h.mockGetLocalConfig.mockImplementation(() => {
    const inSubframe = h.running.frame !== 0
    const gate = inSubframe ? hostSide.subframeConfigGate : hostSide.configGate
    return gate
      ? gate.promise
      : Promise.resolve(inSubframe ? hostSide.subframeConfig : hostSide.config)
  })
  h.mockCheckProviderAvailability.mockImplementation((provider: { config: unknown }) =>
    Promise.resolve({ available: true, providerRef: { kind: "local", config: provider.config } }),
  )
  h.mockWalkAndLabelElementChunked.mockImplementation(() =>
    walkGate.held
      ? walkGate.held.promise
      : Promise.resolve({ forceBlock: false, isInlineNode: false }),
  )
  h.mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")

  const isTabState = (key: string) => key.startsWith(TAB_STATE_PREFIX)
  const realGetItem = storage.getItem.bind(storage)
  const realSetItem = storage.setItem.bind(storage)
  const realRemoveItem = storage.removeItem.bind(storage)
  vi.spyOn(storage, "getItem").mockImplementation(async (key: any, opts?: any) =>
    isTabState(key) ? memory.get(key) : realGetItem(key, opts),
  )
  vi.spyOn(storage, "setItem").mockImplementation(async (key: string, value: unknown) => {
    if (isTabState(key)) memory.set(key, value)
    else await realSetItem(key as any, value as any)
  })
  vi.spyOn(storage, "removeItem").mockImplementation(async (key: string) => {
    if (isTabState(key)) memory.delete(key)
    else await realRemoveItem(key as any)
  })
  vi.spyOn(browser.tabs, "get").mockResolvedValue({ id: TAB_ID, url: PAGE_URL } as any)
  vi.spyOn(browser.tabs, "query").mockResolvedValue([{ id: TAB_ID }] as any)
  browser.tabs.onRemoved.addListener = vi.fn<(...args: any[]) => any>()
  browser.tabs.onActivated.addListener = vi.fn<(...args: any[]) => any>()
  browser.webNavigation.onCommitted.addListener = vi.fn<(...args: any[]) => any>()
  vi.spyOn(toastManager, "add").mockReturnValue("toast-id")

  translationMessage()
  await bootstrapHost()
})

afterEach(() => {
  cleanup()
  fakeBrowser.reset()
  invalidate?.()
  invalidate = undefined
  endPageTranslationSession()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("popup: the page manager accepted the start", () => {
  it("flips to show original, and does not wait for the page walk to finish", async () => {
    walkGate.held = createDeferred() // the initial walk of a long page: still running
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    expect(showOriginalButton()).toBeEnabled()
    expectNoHint()
    // The manager really is translating, and its walk really has not returned.
    expect(activations()).toHaveLength(1)
    expect(getPageTranslationSessionId()).not.toBeNull()
    expect(h.mockWalkAndLabelElementChunked).toHaveBeenCalled()
    expect(notices()).toEqual([])
  })

  it("an answer from a page that predates the outcome (no start field) still counts as accepted", async () => {
    // A content script from before an update answers a toggle with nothing at all.
    h.handlers.delete("askManagerToTogglePageTranslation")
    h.onMessage("askManagerToTogglePageTranslation", () => undefined)
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
  })

  it("a stop flips back and records the user's refusal, as before", async () => {
    const jotaiStore = await renderPopup({ translated: true })

    fireEvent.click(showOriginalButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false))
    expect(askedTheTab(false)).toHaveLength(1)
    expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
    expectNoHint()
  })
})

describe("popup: the page manager received the start but refused it", () => {
  it("same source and target language: stays on Translate, no generic hint, the manager's notice stays", async () => {
    hostSide.config = makeConfig({ sameLanguage: true })
    const jotaiStore = await renderPopup({ popupConfig: makeConfig({ sameLanguage: true }) })

    fireEvent.click(translateButton())

    // The start was delivered and the manager said why it refused.
    await waitFor(() => expect(notices()).toContain(SAME_LANGUAGE_NOTICE))
    await flush()
    expect(askedTheTab(true)).toHaveLength(1)
    // The popup does not claim a translation that never began.
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(translateButton()).toBeEnabled()
    expect(screen.queryByRole("button", { name: /^popup\.showOriginal/ })).not.toBeInTheDocument()
    // The manager's own error is the surface: the generic refresh hint does not cover it.
    expectNoHint()
    expect(notices()).toEqual([SAME_LANGUAGE_NOTICE])
    expectPageUntouched()
  })

  it("provider no longer available to the page (#79): stays on Translate, the provider-required notice stays", async () => {
    // The popup rendered while a provider was selected; by the time the page reads the config the
    // selection no longer resolves (changed from another surface).
    hostSide.config = makeConfig({ providerId: "provider-that-is-gone" })
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(notices()).toContain(PROVIDER_REQUIRED_NOTICE))
    await flush()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(translateButton()).toBeEnabled()
    expectNoHint()
    expectPageUntouched()
  })

  it("a provider that needs an API key and has none: stays on Translate, the key notice stays", async () => {
    hostSide.config = makeConfig({ apiKey: "" })
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(notices()).toContain(NO_KEY_NOTICE))
    await flush()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expectNoHint()
    expectPageUntouched()
  })

  it("provider availability refused: stays on Translate and the manager's error notice stays", async () => {
    h.mockCheckProviderAvailability.mockResolvedValue({
      available: false,
      message: "Provider is not available",
    })
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(notices()).toContain("Provider is not available"))
    await flush()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expectNoHint()
    expectPageUntouched()
  })

  it("the start is cancelled by an OFF from another surface before it was accepted: the popup does not show ON", async () => {
    hostSide.configGate = createDeferred<Config>() // the start is still reading its config
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())
    await waitFor(() => expect(askedTheTab(true)).toHaveLength(1))
    // Another surface (the floating button, the context menu) turns it off meanwhile.
    await h.sendMessage("tryToSetEnablePageTranslationByTabId", { tabId: TAB_ID, enabled: false })
    hostSide.configGate.resolve(hostSide.config)
    await flush()

    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expectNoHint()
    // The user's explicit OFF stays recorded and nothing was activated.
    expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
    expect(activations()).toHaveLength(0)
    expect(getPageTranslationSessionId()).toBeNull()
  })

  it("the button is usable again, and a later start with the settings fixed is accepted without an OFF in between", async () => {
    hostSide.config = makeConfig({ sameLanguage: true })
    const jotaiStore = await renderPopup({ popupConfig: makeConfig({ sameLanguage: true }) })
    fireEvent.click(translateButton())
    await waitFor(() => expect(notices()).toContain(SAME_LANGUAGE_NOTICE))
    await flush()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)

    hostSide.config = makeConfig() // the user fixes the language and tries again
    fireEvent.click(translateButton())

    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    expect(askedTheTab(true)).toHaveLength(2)
    expect(askedTheTab(false)).toHaveLength(0)
    expect(activations()).toHaveLength(1)
  })
})

describe("popup: the delivery contract is unchanged", () => {
  it("no receiver in the tab: stays on Translate and shows the refresh hint", async () => {
    h.transport.hostPresent = false
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
    expect(screen.queryByText(NO_ANSWER_HINT)).not.toBeInTheDocument()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(translateButton()).toBeEnabled()
    expect(tabState()).toBeUndefined()
  })

  describe("a reply that does not come", () => {
    const settle = (ms = 0) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })

    it("shows the hint at the deadline, ignores the reply that comes later, and works again", async () => {
      h.transport.holdTabReplies = true
      const jotaiStore = await renderPopup()
      vi.useFakeTimers()

      fireEvent.click(translateButton())
      await settle()
      expect(askedTheTab(true)).toHaveLength(1)
      await settle(DEADLINE_MS - 1)
      expectNoHint()
      await settle(1)
      expect(screen.getByText(NO_ANSWER_HINT)).toBeInTheDocument()
      expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
      expect(translateButton()).toBeEnabled()

      // The page did accept the start and its reply finally arrives: the popup gave up on that
      // attempt, so it changes nothing on screen.
      h.transport.heldTabReplies[0]!()
      await settle()
      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
      expect(screen.getByText(NO_ANSWER_HINT)).toBeInTheDocument()
      expect(screen.queryByText(REFRESH_HINT)).not.toBeInTheDocument()
    })

    it("a reply that comes after the button was unmounted changes nothing", async () => {
      h.transport.holdTabReplies = true
      const jotaiStore = await renderPopup()

      fireEvent.click(translateButton())
      await waitFor(() => expect(askedTheTab(true)).toHaveLength(1))
      cleanup() // the React subtree goes away; the store stays alive
      h.transport.heldTabReplies[0]!()
      await flush()

      expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    })
  })
})

describe("the host listener's answer to a start", () => {
  const ask = (enabled: boolean) =>
    h.handlers.get("askManagerToTogglePageTranslation")!({
      data: {
        enabled,
        analyticsContext: enabled
          ? createFeatureUsageContext(ANALYTICS_FEATURE.PAGE_TRANSLATION, ANALYTICS_SURFACE.POPUP)
          : undefined,
      },
    })

  it("accepted once the precheck passes, before the page walk has finished", async () => {
    walkGate.held = createDeferred()

    // The answer arrives although the walk (held above) never returns.
    const answer = await ask(true)

    expect(answer).toEqual({ start: "accepted" })
    expect(getPageTranslationSessionId()).not.toBeNull()
    // The page walk starts after the acceptance and is still running.
    await flush()
    expect(h.mockWalkAndLabelElementChunked).toHaveBeenCalled()
  })

  it("rejected when the precheck refuses (same language), with the manager's notice shown", async () => {
    hostSide.config = makeConfig({ sameLanguage: true })

    const answer = await ask(true)

    expect(answer).toEqual({ start: "rejected" })
    expect(notices()).toEqual([SAME_LANGUAGE_NOTICE])
    expectPageUntouched()
  })

  it("a second ON while the first is still pending gets the first one's answer, and starts nothing twice", async () => {
    hostSide.configGate = createDeferred<Config>()

    const first = ask(true)
    await flush()
    const second = ask(true)
    await flush()
    hostSide.configGate.resolve(hostSide.config)

    expect(await first).toEqual({ start: "accepted" })
    expect(await second).toEqual({ start: "accepted" })
    expect(activations()).toHaveLength(1)
  })

  it("an ON for a page that is already translating is accepted", async () => {
    await ask(true)

    expect(await ask(true)).toEqual({ start: "accepted" })
    expect(activations()).toHaveLength(1)
  })

  it("an OFF that cancels a pending start answers that start as rejected", async () => {
    hostSide.configGate = createDeferred<Config>()

    const start = ask(true)
    await flush()
    await ask(false)
    hostSide.configGate.resolve(hostSide.config)

    expect(await start).toEqual({ start: "rejected" })
    expectPageUntouched()
  })

  it("a stop and a new start while the first is held: the new one stays active and the old listeners hear only a rejection", async () => {
    // Start A waits on its config read; a duplicate ON attaches to it.
    hostSide.configGate = createDeferred<Config>()
    const gateOfA = hostSide.configGate
    const firstOfA = ask(true)
    await flush()
    const duplicateOfA = ask(true)
    await flush()

    // The user stops it, and a new start (B) is made and accepted before A's read lands.
    await ask(false)
    hostSide.configGate = null
    expect(await ask(true)).toEqual({ start: "accepted" })
    expect(getPageTranslationSessionId()).not.toBeNull()

    // A's read finally lands with settings that would refuse it.
    gateOfA.resolve(makeConfig({ sameLanguage: true }))

    expect(await firstOfA).toEqual({ start: "rejected" })
    expect(await duplicateOfA).toEqual({ start: "rejected" })
    // B was not disturbed: still active, activated once, and A's cancelled start said nothing.
    expect(getPageTranslationSessionId()).not.toBeNull()
    expect(activations()).toHaveLength(1)
    expect(notices()).toEqual([])
  })

  it("an OFF itself carries no start outcome", async () => {
    await ask(true)

    expect(await ask(false)).toBeUndefined()
  })
})

/**
 * The host listeners another frame of the tab registers (a frame that is not the top one), backed by
 * a real manager of its own: its own config read, its own timing, its own precheck. The ask listener
 * is the host runtime's, for a frame whose analytics context is dropped.
 */
function addSubframe(frameId: number) {
  const manager = new PageTranslationManager()
  const asked: boolean[] = []
  h.subframes.set(
    frameId,
    new Map([
      [
        "askManagerToTogglePageTranslation",
        (msg: any) => {
          const { enabled } = msg.data as { enabled: boolean }
          asked.push(enabled)
          if (enabled && manager.isActive) return { start: "accepted" }
          if (enabled) {
            return new Promise((resolve) => {
              void manager.start(undefined, (start) => resolve({ start }))
            })
          }
          manager.stop({ userInitiated: true })
          return undefined
        },
      ],
    ]),
  )
  return { manager, asked }
}

describe("popup: only the top frame's manager decides what the popup shows", () => {
  const SUBFRAME = 5

  it("asks the top frame, for a start and for a stop", async () => {
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())
    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    fireEvent.click(showOriginalButton())
    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false))

    expect(askedTheTab(true).map((message) => message.frameId)).toEqual([0])
    expect(askedTheTab(false).map((message) => message.frameId)).toEqual([0])
  })

  it("the top frame accepts after a subframe has already refused: the popup shows ON", async () => {
    // The top frame's config read is still on its way; the subframe's lands at once, same language.
    hostSide.configGate = createDeferred<Config>()
    hostSide.subframeConfig = makeConfig({ sameLanguage: true })
    addSubframe(SUBFRAME)
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())
    await flush()
    hostSide.configGate.resolve(makeConfig())

    // The top frame activated and the popup says so, whatever the subframe made of the same request.
    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    expect(showOriginalButton()).toBeEnabled()
    expectNoHint()
    expect(activations()).toHaveLength(1)
    expect(getPageTranslationSessionId()).not.toBeNull()
    expect(tabState()).toEqual({ enabled: true, origin: PAGE_ORIGIN })
  })

  it("the top frame refuses after a subframe has already accepted: the popup stays on Translate and the top frame's notice stays", async () => {
    // The top frame's config read is still on its way (it will say same language); the subframe's
    // valid one lands at once and its manager accepts first.
    hostSide.configGate = createDeferred<Config>()
    hostSide.subframeConfig = makeConfig()
    addSubframe(SUBFRAME)
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())
    await flush()
    hostSide.configGate.resolve(makeConfig({ sameLanguage: true }))
    await waitFor(() => expect(notices()).toContain(SAME_LANGUAGE_NOTICE))
    await flush()

    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(translateButton()).toBeEnabled()
    expectNoHint()
  })

  it("no receiver in the top frame while a subframe could answer: stays on Translate and shows the refresh hint", async () => {
    // A tab whose own document has no host runtime (opened before the install, context invalidated)
    // while an injected subframe has one: a subframe's answer is not the tab's.
    h.handlers.delete("askManagerToTogglePageTranslation")
    addSubframe(SUBFRAME)
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())

    await waitFor(() => expect(screen.getByText(REFRESH_HINT)).toBeInTheDocument())
    expect(screen.queryByText(NO_ANSWER_HINT)).not.toBeInTheDocument()
    expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false)
    expect(translateButton()).toBeEnabled()
  })

  it("the other frames still follow the top frame: a start and a stop reach a subframe through the state broadcast", async () => {
    const heard: boolean[] = []
    h.subframes.set(
      SUBFRAME,
      new Map([
        [
          "notifyTranslationStateChanged",
          (msg: any) => {
            heard.push(msg.data.enabled)
          },
        ],
      ]),
    )
    const jotaiStore = await renderPopup()

    fireEvent.click(translateButton())
    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(true))
    await flush()
    expect(heard).toContain(true)
    expect(heard).not.toContain(false)

    fireEvent.click(showOriginalButton())
    await waitFor(() => expect(jotaiStore.get(isPageTranslatedAtom)).toBe(false))
    await flush()
    expect(heard.at(-1)).toBe(false)
  })
})
