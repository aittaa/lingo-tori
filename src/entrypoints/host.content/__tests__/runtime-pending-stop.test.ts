// @vitest-environment jsdom
// An OFF that arrives while a page-translation start is still awaiting its
// pre-activation gates (config read, provider availability) must cancel that
// start. The manager is not "active" until those gates pass, so an equality
// guard on `isActive` in the content runtime dropped the OFF and the start then
// activated translation after the user had turned it off — and its ON
// notification overwrote the background's manual-off record.
//
// The real runtime message handlers, the real PageTranslationManager and the
// real background translation-signal handlers run here, wired through an
// in-memory message bus. Only the config read and the availability gate (held
// as deferred promises), the transport, and the DOM work the manager would start
// (walk, title request, observers) are test doubles.

import type { ContentScriptContext } from "#imports"
import type { Config } from "@/types/config/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { toastManager } from "@/components/ui/base-ui/toast"
import { translationMessage } from "@/entrypoints/background/translation-signal"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { DEFAULT_CONFIG as EMPTY_CONFIG } from "@/utils/constants/config"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import {
  endPageTranslationSession,
  getPageTranslationSessionId,
} from "@/utils/host/translate/translation-session"
import { getPageTranslationOriginScope } from "@/utils/url"
import { bootstrapHostContent } from "../runtime"

const TAB_ID = 7
// The page the manager reports is `window.location`; the popup path asks the tab
// API. Keeping them one URL keeps the background's origin-scoped records comparable.
const PAGE_URL = window.location.href
const PAGE_ORIGIN = getPageTranslationOriginScope(PAGE_URL)
const IFRAME_FRAME_ID = 5

const h = vi.hoisted(() => {
  type Handler = (msg: any) => any
  const handlers = new Map<string, Handler>()
  const sent: Array<{ name: string; data: any; tabId?: number }> = []
  // Messages a content script sends to the background; everything else goes the
  // other way and arrives without a sender, like in the real transport.
  const backgroundBound = new Set([
    "setAndNotifyPageTranslationStateChangedByManager",
    "getEnablePageTranslationFromContentScript",
    "reportDetectedPageLanguage",
    "cancelPageTranslationRequests",
    "tryToSetEnablePageTranslationByTabId",
    "tryToSetEnablePageTranslationOnContentScript",
  ])
  const frame = { id: 0 }
  function sendMessage(name: string, data?: any, tabId?: number): Promise<any> {
    sent.push({ name, data, tabId })
    const handler = handlers.get(name)
    if (!handler) return Promise.resolve(undefined)
    const msg = backgroundBound.has(name)
      ? {
          data,
          sender: { tab: { id: 7, url: window.location.href }, frameId: frame.id },
        }
      : { data }
    return Promise.resolve().then(() => handler(msg))
  }
  function onMessage(name: string, handler: Handler) {
    handlers.set(name, handler)
    return () => {
      if (handlers.get(name) === handler) handlers.delete(name)
    }
  }
  return {
    handlers,
    sent,
    frame,
    sendMessage,
    onMessage,
    mockGetLocalConfig: vi.fn<(...args: any[]) => any>(),
    mockCheckProviderAvailability: vi.fn<(...args: any[]) => any>(),
    mockWalkAndLabelElementChunked: vi.fn<(...args: any[]) => any>(),
    mockTranslateTextForPageTitle: vi.fn<(...args: any[]) => any>(),
    mockRemoveAllTranslatedWrapperNodes: vi.fn<(...args: any[]) => any>(),
    mockShouldEnableAutoTranslation: vi.fn<(...args: any[]) => any>(),
    intersectionObservers: [] as unknown[],
  }
})

vi.mock("@/utils/message", () => ({
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
  removeAllTranslatedWrapperNodes: h.mockRemoveAllTranslatedWrapperNodes,
  translateWalkedElement: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/translate-variants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/translate/translate-variants")>()),
  translateTextForPageTitle: h.mockTranslateTextForPageTitle,
}))

vi.mock("@/utils/host/translate/auto-translation", () => ({
  shouldEnableAutoTranslation: h.mockShouldEnableAutoTranslation,
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

vi.mock("@/entrypoints/background/iframe-injection", () => ({
  injectHostContentIntoTabIframes: vi.fn<(...args: any[]) => any>(),
  injectHostContentIntoCurrentTabIframesAfterNodeTranslation: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("../listen", () => ({ setupUrlChangeListener: () => () => {} }))
vi.mock("../mount-host-toast", () => ({ mountHostToast: () => () => {} }))
vi.mock("../translation-control/bind-translation-shortcut", () => ({
  bindTranslationShortcutKey: async () => () => {},
}))
vi.mock("../translation-control/bind-translation-mode-shortcut", () => ({
  bindTranslationModeShortcutKey: async () => () => {},
}))
vi.mock("../translation-control/node-translation", () => ({
  registerNodeTranslationTriggers: () => () => {},
}))

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

const CONFIG = {
  ...EMPTY_CONFIG,
  providersConfig: [
    {
      id: "test-deepl",
      provider: "deepl" as const,
      enabled: true,
      name: "Test DeepL",
      apiKey: "test-key",
    },
  ],
  pageTranslation: { ...EMPTY_CONFIG.pageTranslation, providerId: "test-deepl" },
} as Config

const NO_PROVIDER_CONFIG = {
  ...CONFIG,
  pageTranslation: { ...CONFIG.pageTranslation, providerId: "missing-provider" },
}

type Gate = "config read" | "provider availability check"

/** One deferred per gated call, in call order. A gate that is not held resolves at once. */
const held = {
  config: false,
  availability: false,
  configCalls: [] as Array<Deferred<Config>>,
  availabilityCalls: [] as Array<Deferred<unknown>>,
  config_value: CONFIG,
}

function holdGate(gate: Gate): void {
  if (gate === "config read") held.config = true
  else held.availability = true
}

function pendingStartCalls(gate: Gate): Array<{ resolve: () => void }> {
  if (gate === "config read") {
    return held.configCalls.map((call) => ({ resolve: () => call.resolve(held.config_value) }))
  }
  return held.availabilityCalls.map((call) => ({
    resolve: () => call.resolve({ available: true, providerRef: { kind: "local", config: {} } }),
  }))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** The popup / floating button / context menu surface: the background records the choice first. */
async function userToggles(enabled: boolean): Promise<void> {
  await h.sendMessage("tryToSetEnablePageTranslationByTabId", {
    tabId: TAB_ID,
    enabled,
    analyticsContext: enabled
      ? createFeatureUsageContext(ANALYTICS_FEATURE.PAGE_TRANSLATION, ANALYTICS_SURFACE.POPUP)
      : undefined,
  })
  await flush()
}

function sentToBackground(name: string, predicate: (data: any) => boolean = () => true) {
  return h.sent.filter((message) => message.name === name && predicate(message.data))
}

function activationNotifications() {
  return sentToBackground(
    "setAndNotifyPageTranslationStateChangedByManager",
    (data) => data.enabled === true,
  )
}

const store = new Map<string, unknown>()
const tabStateKey = getTranslationStateKey(TAB_ID)

function tabState() {
  return store.get(tabStateKey)
}

let invalidate: (() => void) | undefined

async function bootstrap(): Promise<void> {
  const callbacks: Array<() => void> = []
  const ctx = {
    onInvalidated: (cb: () => void) => callbacks.push(cb),
  } as unknown as ContentScriptContext
  invalidate = () => callbacks.forEach((cb) => cb())
  await bootstrapHostContent(ctx, null)
  await flush()
}

/** Soft, so one failing run lists every property a start that should have been cancelled broke. */
function expectNoActivation(): void {
  expect.soft(activationNotifications()).toHaveLength(0)
  expect.soft(getPageTranslationSessionId()).toBeNull()
  expect.soft(h.intersectionObservers).toHaveLength(0)
  expect.soft(h.mockWalkAndLabelElementChunked).not.toHaveBeenCalled()
  expect.soft(h.mockTranslateTextForPageTitle).not.toHaveBeenCalled()
  expect.soft(document.title).toBe("Original Title")
}

/** Only the top frame owns the tab title, so a frame activates without a title request. */
function expectOneActivation({ title = true }: { title?: boolean } = {}): void {
  expect(activationNotifications()).toHaveLength(1)
  expect(getPageTranslationSessionId()).not.toBeNull()
  expect(h.intersectionObservers).toHaveLength(1)
  expect(h.mockWalkAndLabelElementChunked).toHaveBeenCalledTimes(1)
  expect(h.mockTranslateTextForPageTitle).toHaveBeenCalledTimes(title ? 1 : 0)
  expect(document.title).toBe(title ? "Translated Title" : "Original Title")
}

beforeEach(() => {
  h.handlers.clear()
  h.sent.length = 0
  h.frame.id = 0
  h.intersectionObservers.length = 0
  held.config = false
  held.availability = false
  held.configCalls.length = 0
  held.availabilityCalls.length = 0
  held.config_value = CONFIG
  store.clear()
  vi.clearAllMocks()

  document.head.innerHTML = ""
  document.body.innerHTML = "<main>Article body</main>"
  document.title = "Original Title"
  delete window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)

  h.mockGetLocalConfig.mockImplementation(() => {
    if (!held.config) return Promise.resolve(held.config_value)
    const call = createDeferred<Config>()
    held.configCalls.push(call)
    return call.promise
  })
  h.mockCheckProviderAvailability.mockImplementation((provider: { config: unknown }) => {
    if (!held.availability) {
      return Promise.resolve({
        available: true,
        providerRef: { kind: "local", config: provider.config },
      })
    }
    const call = createDeferred<unknown>()
    held.availabilityCalls.push(call)
    return call.promise
  })
  h.mockWalkAndLabelElementChunked.mockResolvedValue({ forceBlock: false, isInlineNode: false })
  h.mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")
  h.mockShouldEnableAutoTranslation.mockResolvedValue(false)

  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  vi.spyOn(storage, "getItem").mockImplementation(async (key: string) => store.get(key))
  vi.spyOn(storage, "setItem").mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value)
  })
  vi.spyOn(storage, "removeItem").mockImplementation(async (key: string) => {
    store.delete(key)
  })
  vi.spyOn(browser.tabs, "get").mockResolvedValue({ id: TAB_ID, url: PAGE_URL } as any)
  vi.spyOn(browser.tabs, "query").mockResolvedValue([{ id: TAB_ID }] as any)
  browser.tabs.onRemoved.addListener = vi.fn<(...args: any[]) => any>()
  browser.tabs.onActivated.addListener = vi.fn<(...args: any[]) => any>()
  browser.webNavigation.onCommitted.addListener = vi.fn<(...args: any[]) => any>()
  vi.spyOn(toastManager, "add").mockReturnValue("toast-id")

  translationMessage()
})

afterEach(() => {
  invalidate?.()
  invalidate = undefined
  endPageTranslationSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a user OFF while a page-translation start is pending (top frame)", () => {
  describe.each<Gate>(["config read", "provider availability check"])("during the %s", (gate) => {
    it("cancels the start: no session, no activation notice, no title or body work, manual-off kept", async () => {
      holdGate(gate)
      await bootstrap()

      await userToggles(true)
      expect(pendingStartCalls(gate)).toHaveLength(1)

      await userToggles(false)
      pendingStartCalls(gate).forEach((call) => call.resolve())
      await flush()

      expectNoActivation()
      // The background's refusal record is what stops auto-translation from
      // re-enabling the page; the late ON notification used to overwrite it.
      expect.soft(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
      // The cancelled start is silent: no provider toast either.
      expect.soft(toastManager.add).not.toHaveBeenCalled()
    })

    it("a fresh ON after the cancelled start has resolved activates exactly once", async () => {
      holdGate(gate)
      await bootstrap()
      await userToggles(true)
      await userToggles(false)
      pendingStartCalls(gate).forEach((call) => call.resolve())
      await flush()
      expectNoActivation()

      held.config = false
      held.availability = false
      await userToggles(true)

      expectOneActivation()
      expect(tabState()).toEqual({ enabled: true, origin: PAGE_ORIGIN })
    })

    it.each(["cancelled start resolves first", "newer start resolves first"])(
      "OFF then ON while pending: the final ON wins with exactly one activation (%s)",
      async (order) => {
        holdGate(gate)
        await bootstrap()

        await userToggles(true)
        await userToggles(false)
        await userToggles(true)

        const calls = pendingStartCalls(gate)
        const releaseOrder = order === "cancelled start resolves first" ? [0, 1] : [1, 0]
        for (const index of releaseOrder) {
          calls[index]?.resolve()
          await flush()
        }

        expectOneActivation()
        expect(tabState()).toEqual({ enabled: true, origin: PAGE_ORIGIN })
        expect(sentToBackground("setAndNotifyPageTranslationStateChangedByManager")).toHaveLength(1)
      },
    )

    it("a duplicate ON while pending is still deduped to one start", async () => {
      holdGate(gate)
      await bootstrap()

      await userToggles(true)
      await userToggles(true)
      expect(pendingStartCalls(gate)).toHaveLength(1)
      pendingStartCalls(gate).forEach((call) => call.resolve())
      await flush()

      expectOneActivation()
      expect(tabState()).toEqual({ enabled: true, origin: PAGE_ORIGIN })
    })
  })

  it("cancels the automatic start a reloaded page makes at bootstrap", async () => {
    store.set(tabStateKey, { enabled: true, origin: PAGE_ORIGIN })
    holdGate("config read")
    await bootstrap()
    expect(pendingStartCalls("config read")).toHaveLength(1)

    await userToggles(false)
    pendingStartCalls("config read").forEach((call) => call.resolve())
    await flush()

    expectNoActivation()
    expect.soft(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
  })

  it("floating-button OFF (sent from the content script) cancels the pending start too", async () => {
    holdGate("config read")
    await bootstrap()
    await userToggles(true)

    await h.sendMessage("tryToSetEnablePageTranslationOnContentScript", { enabled: false })
    await flush()
    pendingStartCalls("config read").forEach((call) => call.resolve())
    await flush()

    expectNoActivation()
    expect.soft(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
  })

  it("the provider-required guidance (#79) still shows once for a user start, and not for a cancelled one", async () => {
    held.config_value = NO_PROVIDER_CONFIG
    await bootstrap()

    await userToggles(true)
    expect(toastManager.add).toHaveBeenCalledTimes(1)
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "providerRequired.message" }),
    )
    expectNoActivation()

    vi.mocked(toastManager.add).mockClear()
    holdGate("config read")
    await userToggles(true)
    await userToggles(false)
    pendingStartCalls("config read").forEach((call) => call.resolve())
    await flush()

    expect.soft(toastManager.add).not.toHaveBeenCalled()
    expectNoActivation()
  })
})

describe("unchanged top-frame toggles", () => {
  it("a normal ON with no OFF activates once", async () => {
    await bootstrap()

    await userToggles(true)

    expectOneActivation()
    expect(tabState()).toEqual({ enabled: true, origin: PAGE_ORIGIN })
    // The session id and the notice both carry the page URL.
    expect(activationNotifications()[0]!.data).toEqual({ enabled: true, url: PAGE_URL })
  })

  it("a redundant ON while already active is skipped", async () => {
    await bootstrap()
    await userToggles(true)
    const sessionId = getPageTranslationSessionId()

    await userToggles(true)

    expect(activationNotifications()).toHaveLength(1)
    expect(getPageTranslationSessionId()).toBe(sessionId)
    expect(h.mockWalkAndLabelElementChunked).toHaveBeenCalledTimes(1)
  })

  it("OFF while active tears the session down and records the refusal", async () => {
    await bootstrap()
    await userToggles(true)
    const sessionId = getPageTranslationSessionId()
    expect(sessionId).not.toBeNull()

    await userToggles(false)

    expect(sentToBackground("setAndNotifyPageTranslationStateChangedByManager")).toHaveLength(2)
    expect(
      sentToBackground("setAndNotifyPageTranslationStateChangedByManager").at(-1)!.data,
    ).toEqual({ enabled: false, url: PAGE_URL, userInitiated: true })
    expect(sentToBackground("cancelPageTranslationRequests")).toHaveLength(1)
    expect(sentToBackground("cancelPageTranslationRequests")[0]!.data).toEqual({ sessionId })
    expect(getPageTranslationSessionId()).toBeNull()
    expect(h.mockRemoveAllTranslatedWrapperNodes).toHaveBeenCalled()
    expect(document.title).toBe("Original Title")
    expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
  })

  it("OFF with nothing active or pending is a quiet no-op", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await bootstrap()

    await userToggles(false)

    expectNoActivation()
    expect(sentToBackground("setAndNotifyPageTranslationStateChangedByManager")).toHaveLength(0)
    expect(sentToBackground("cancelPageTranslationRequests")).toHaveLength(0)
    expect(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
    // Every frame of the tab receives an OFF; the idle ones must not log about it.
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("a user OFF while an iframe's start is pending", () => {
  const originalTop = Object.getOwnPropertyDescriptor(window, "top")

  beforeEach(() => {
    Object.defineProperty(window, "top", { configurable: true, value: {} })
    h.frame.id = IFRAME_FRAME_ID
  })

  afterEach(() => {
    if (originalTop) Object.defineProperty(window, "top", originalTop)
    else delete (window as any).top
  })

  it("is not the top frame in this harness", () => {
    expect(window === window.top).toBe(false)
  })

  describe.each<Gate>(["config read", "provider availability check"])("during the %s", (gate) => {
    it.each([
      ["the state broadcast", "notifyTranslationStateChanged"],
      ["the manager toggle request", "askManagerToTogglePageTranslation"],
    ] as const)("%s cancels the start", async (_label, messageName) => {
      store.set(tabStateKey, { enabled: true, origin: PAGE_ORIGIN })
      holdGate(gate)
      await bootstrap()
      expect(pendingStartCalls(gate)).toHaveLength(1)

      await h.sendMessage(messageName, { enabled: false })
      await flush()
      pendingStartCalls(gate).forEach((call) => call.resolve())
      await flush()

      expectNoActivation()
    })

    it("the whole popup OFF (broadcast and toggle request together) cancels the start", async () => {
      store.set(tabStateKey, { enabled: true, origin: PAGE_ORIGIN })
      holdGate(gate)
      await bootstrap()

      await userToggles(false)
      pendingStartCalls(gate).forEach((call) => call.resolve())
      await flush()

      expectNoActivation()
      // The iframe never writes tab-level state.
      expect.soft(tabState()).toEqual({ enabled: false, userDisabled: true, origin: PAGE_ORIGIN })
    })
  })

  it("a state broadcast ON still starts the iframe once, and a repeat is skipped", async () => {
    await bootstrap()

    await h.sendMessage("notifyTranslationStateChanged", { enabled: true })
    await flush()
    await h.sendMessage("notifyTranslationStateChanged", { enabled: true })
    await flush()

    expectOneActivation({ title: false })
    expect(activationNotifications()[0]!.data).toEqual({ enabled: true, url: PAGE_URL })
  })

  it("a state broadcast OFF stops an active iframe", async () => {
    await bootstrap()
    await h.sendMessage("notifyTranslationStateChanged", { enabled: true })
    await flush()
    expect(getPageTranslationSessionId()).not.toBeNull()

    await h.sendMessage("notifyTranslationStateChanged", { enabled: false })
    await flush()

    expect(getPageTranslationSessionId()).toBeNull()
    expect(sentToBackground("cancelPageTranslationRequests")).toHaveLength(1)
    expect(h.mockRemoveAllTranslatedWrapperNodes).toHaveBeenCalled()
  })

  it("a state broadcast OFF with nothing to stop is a quiet no-op", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await bootstrap()

    await h.sendMessage("notifyTranslationStateChanged", { enabled: false })
    await flush()

    expectNoActivation()
    expect(sentToBackground("setAndNotifyPageTranslationStateChangedByManager")).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })
})
