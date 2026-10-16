// @vitest-environment jsdom
// A selection translated by a pure translate provider (DeepL and the like) is a request nobody owns.
// The popover aborted nothing for it: `cancelCurrentTranslation` aborts only the LLM stream's
// controller, and the request to the background carries no owner, so the background cannot drain
// it either. Closing the popover, pressing Regenerate or opening another selection therefore left
// the request waiting in the queue (or in flight, billed) and let it start after the popover was
// gone; only the UI's run check dropped the answer.
//
// What is pinned here: each run of the standard branch has an owner of its own, in a namespace that
// is never a page-translation session id (`selection:<random>`), carried on the wire as the existing
// `sessionId` and cancelled with the existing `cancelPageTranslationRequests` when the popover closes
// or the run is restarted. A page stop does not touch a selection run, and closing a selection does
// not touch the page's requests. A task another owner still wants keeps running (the shared-owner
// contract), and a run that was cancelled never sends a request afterwards, whatever the
// background still remembers.
//
// Real: SelectionTranslationProvider, the selection atoms, resolveProviderRefForCapability, the
// real translateTextCore, and the background's page-translation handlers with their real
// RequestQueue and cancelled-scope registry, bridged to the content side by an in-memory bus. Doubles:
// the provider edge (`executeTranslate`, one deferred per call, with the abort signal it was given),
// the stored config and cache, and the page context and glossary lookups where a test holds them.

import type { ReactNode, Ref } from "react"
import type { Config } from "@/types/config/config"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { setupPageTranslationHandlers } from "@/entrypoints/background/page-translation"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { isTranslationCancelledError } from "@/utils/request/cancellation"
import { SelectionTranslationProvider } from "../translate-button/provider"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (message: { data: any; sender?: unknown }) => any>()
  const sent: Array<{ name: string; data: any; result: Promise<unknown> }> = []
  // The tab every message of this process comes from, as the background sees the sender.
  const TAB = 7
  const hold = {
    cancels: false,
    heldCancels: [] as Array<() => void>,
  }
  function bus(name: string, data?: any): Promise<unknown> {
    const listener = listeners.get(name)
    const deliver = () =>
      listener
        ? Promise.resolve().then(() => listener({ data, sender: { tab: { id: TAB } } }))
        : Promise.resolve(undefined)
    let result: Promise<unknown>
    if (name === "cancelPageTranslationRequests" && hold.cancels) {
      result = new Promise((resolve, reject) => {
        hold.heldCancels.push(() => deliver().then(resolve, reject))
      })
    } else {
      result = deliver()
    }
    sent.push({ name, data, result })
    return result
  }
  return {
    TAB,
    listeners,
    sent,
    hold,
    bus,
    executeTranslate: vi.fn<(...args: any[]) => any>(),
    ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
    trackFeatureUsed: vi.fn<(...args: any[]) => any>(),
    // One-shot holds on the content side's own awaits.
    heldContext: [] as Array<Deferred<null>>,
    heldGlossary: [] as Array<Deferred<{ terms: never[]; revision: number }>>,
    cacheGet: vi.fn<(...args: any[]) => any>(),
    // The newest handler the provider under test registered with useSelectionShortcuts.
    shortcutHandler: undefined as ((id: string, session: unknown) => boolean) | undefined,
    session: {
      id: 1,
      createdAt: 0,
      selectionSnapshot: { text: "Hello world" },
      contextSnapshot: { text: "Hello world, hello.", paragraphs: [] as string[] },
    },
  }
})

// The real config atom is storage-backed; a plain atom lets a test set the config directly.
vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  const { selectAtom } = await import("jotai/utils")
  const { DEFAULT_CONFIG: defaults } = await import("@/utils/constants/config")
  const config = atom(defaults)
  return {
    configAtom: config,
    configFieldsAtomMap: {
      language: selectAtom(config, (value) => value.language),
      providersConfig: selectAtom(config, (value) => value.providersConfig),
      selectionToolbar: selectAtom(config, (value) => value.selectionToolbar),
    },
    writeConfigAtom: atom(null, () => {}),
  }
})

// One process, one bus: the background's handlers and the popover's own listeners register here,
// and a message from the content side is handled by whichever listener has its name.
vi.mock("@/utils/message", () => ({
  sendMessage: mocks.bus,
  onMessage: (type: string, listener: (message: { data: unknown }) => unknown) => {
    mocks.listeners.set(type, listener)
    return () => {
      mocks.listeners.delete(type)
    }
  },
}))

vi.mock("@/utils/analytics", async () => ({
  ...(await vi.importActual<typeof import("@/utils/analytics")>("@/utils/analytics")),
  trackFeatureUsed: mocks.trackFeatureUsed,
}))

// The background's edges: its stored config, the provider call, the cache and the batch records.
vi.mock("@/entrypoints/background/config", () => ({
  ensureInitializedConfig: mocks.ensureInitializedConfig,
}))
vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: mocks.executeTranslate,
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: { get: vi.fn<() => undefined>(), put: vi.fn<() => undefined>() },
    translationCache: {
      delete: vi.fn<() => undefined>(),
      get: mocks.cacheGet,
      put: vi.fn<() => undefined>(),
    },
  },
}))
vi.mock("@/entrypoints/background/background-stream", () => ({
  runStreamTextInBackground: vi.fn<() => undefined>(),
  generateTextForProviderRef: vi.fn<() => undefined>(),
}))

// The content side's own waits, which a test can hold: the page context and the glossary lookup.
vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: () => mocks.heldContext.shift()?.promise ?? Promise.resolve(null),
}))
vi.mock("@/utils/host/translate/webpage-summary", () => ({
  getOrGenerateWebPageSummary: () => Promise.resolve(null),
}))
vi.mock("@/utils/glossary/active-matcher", async () => ({
  ...(await vi.importActual<typeof import("@/utils/glossary/active-matcher")>(
    "@/utils/glossary/active-matcher",
  )),
  resolveGlossaryTerms: () =>
    mocks.heldGlossary.shift()?.promise ?? Promise.resolve({ terms: [], revision: 0 }),
  resolveGlossaryTermsFromCache: () => [],
}))
vi.mock("@/utils/glossary/analytics", () => ({
  trackGlossaryUsed: () => {},
}))

// The content script entry (shadow root) and the popover chrome.
vi.mock("../..", () => ({ shadowWrapper: undefined }))
vi.mock("@/components/ui/selection-popover", async () => {
  const { createContext, createElement: h, use, useImperativeHandle } = await import("react")
  const Popover = createContext({ open: false, onOpenChange: (_open: boolean) => {} })
  const Box = ({ children }: { children?: ReactNode }) => h("div", null, children)
  return {
    SelectionPopover: {
      Root: ({
        open,
        onOpenChange,
        actionsRef,
        children,
      }: {
        open: boolean
        onOpenChange: (open: boolean) => void
        actionsRef: Ref<unknown>
        children?: ReactNode
      }) => {
        useImperativeHandle(actionsRef, () => ({ requestOpen: () => onOpenChange(true) }))
        return h(Popover.Provider, { value: { open, onOpenChange } }, children)
      },
      Content: ({ children }: { children?: ReactNode }) =>
        use(Popover).open ? h("div", null, children) : null,
      Header: Box,
      Body: Box,
      Pin: () => null,
      Close: () => {
        const { onOpenChange } = use(Popover)
        return h("button", { onClick: () => onOpenChange(false) }, "close")
      },
    },
  }
})
vi.mock("@/components/ui/selection-popover/selection-toolbar-footer-content", async () => {
  const { createElement: h } = await import("react")
  return {
    SelectionToolbarFooterContent: ({ onRegenerate }: { onRegenerate: () => void }) =>
      h("button", { onClick: onRegenerate }, "regenerate"),
  }
})
vi.mock("@/components/ui/selection-popover/selection-toolbar-title-content", () => ({
  SelectionToolbarTitleContent: () => null,
}))
vi.mock("@/components/custom-action/custom-action-content", () => ({
  CustomActionContent: () => null,
}))
vi.mock("@/components/custom-action/custom-action-tool-button", () => ({
  CustomActionToolButton: () => null,
}))
vi.mock("../translate-button/target-language-selector", () => ({
  TargetLanguageSelector: () => null,
}))
vi.mock("../translate-button/translation-content", async () => {
  const { createElement: h } = await import("react")
  return {
    TranslationContent: ({ translatedText }: { translatedText?: string }) =>
      h("p", null, translatedText),
  }
})
vi.mock("../note-suggestion/note-suggestion-card", () => ({ NoteSuggestionCard: () => null }))
vi.mock("../note-suggestion/use-note-suggestion", () => {
  const noteSuggestion = {
    suggestion: null,
    maybeFire: () => {},
    cancel: () => {},
    resetSession: () => {},
    markShownOnce: () => {},
  }
  return { useNoteSuggestion: () => noteSuggestion }
})

// How a selection opens a popover: the shortcut handler is driven by the tests; the open request
// itself always resolves to the same session.
vi.mock("../use-selection-open-request", () => {
  const anchor = { x: 1, y: 2 }
  const resolver = {
    resolveContextMenuOpenRequest: () => ({ anchor, session: mocks.session }),
    resolveShortcutOpenRequest: (session: unknown) => (session ? { anchor, session } : null),
  }
  return { useSelectionOpenRequestResolver: () => resolver }
})
vi.mock("../use-selection-shortcuts", () => ({
  useSelectionShortcuts: (
    _shortcuts: unknown,
    handler: (id: string, session: unknown) => boolean,
  ) => {
    mocks.shortcutHandler = handler
  },
}))

const SELECTION_NAMESPACE = /^selection:/
const PAGE_SESSION = "page-session-1"

const PROVIDER = {
  ...structuredClone(DEFAULT_PROVIDER_CONFIG.deepl),
  id: "deepl-test",
  name: "DeepL",
  enabled: true,
  apiKey: "test-key",
}

function selectionConfig(): Config {
  const { selectionToolbar } = DEFAULT_CONFIG
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [PROVIDER],
    selectionToolbar: {
      ...selectionToolbar,
      features: {
        ...selectionToolbar.features,
        translate: { ...selectionToolbar.features.translate, providerId: PROVIDER.id },
      },
    },
  }
}

function backgroundConfig(requestQueueConfig: { rate: number; capacity: number }) {
  return {
    ...DEFAULT_CONFIG,
    pageTranslation: {
      ...DEFAULT_CONFIG.pageTranslation,
      providerId: PROVIDER.id,
      requestQueueConfig,
    },
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

interface ProviderCall {
  text: string
  signal: AbortSignal | undefined
  answer: Deferred<string>
}
let providerCalls: ProviderCall[]

/** The popover waits on the page context once: the next run's first await is this one. */
function holdPageContext(): Deferred<null> {
  const held = createDeferred<null>()
  mocks.heldContext.push(held)
  return held
}

/** The next request's glossary lookup, inside the core's own preparation. */
function holdGlossaryLookup(): Deferred<{ terms: never[]; revision: number }> {
  const held = createDeferred<{ terms: never[]; revision: number }>()
  mocks.heldGlossary.push(held)
  return held
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

function mountSelection() {
  const store = createStore()
  store.set(configAtom, selectionConfig())
  render(
    createElement(Provider, { store }, createElement(SelectionTranslationProvider, null, null)),
  )
}

async function openTranslation() {
  const handler = mocks.shortcutHandler
  if (!handler) throw new Error("the provider did not register a shortcut handler")
  act(() => {
    handler("translate", mocks.session)
  })
  await flush()
}

async function closePopover() {
  fireEvent.click(screen.getByRole("button", { name: "close" }))
  await flush()
}

async function regenerate() {
  fireEvent.click(screen.getByRole("button", { name: "regenerate" }))
  await flush()
}

const enqueues = () =>
  mocks.sent.filter(
    (m) => m.name === "enqueueTranslateRequest" && m.data.usageFeature === "selectionTranslation",
  )
const cancels = () => mocks.sent.filter((m) => m.name === "cancelPageTranslationRequests")

/** A request the page's own translation would send, from the same tab. */
function pageParagraph(text: string, sessionId = PAGE_SESSION) {
  return mocks.bus("enqueueTranslateRequest", {
    text,
    usageFeature: "pageTranslation",
    langConfig: DEFAULT_CONFIG.language,
    providerRef: { kind: "local", config: PROVIDER },
    scheduleAt: Date.now(),
    hash: `page-${text}`,
    sessionId,
  }) as Promise<string>
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
function track(promise: Promise<unknown>): { outcome: () => Outcome | undefined } {
  let outcome: Outcome | undefined
  promise.then(
    (value) => {
      outcome = { ok: true, value }
    },
    (error: unknown) => {
      outcome = { ok: false, error }
    },
  )
  return { outcome: () => outcome }
}

beforeEach(async () => {
  fakeBrowser.reset()
  mocks.listeners.clear()
  mocks.sent.length = 0
  mocks.hold.cancels = false
  mocks.hold.heldCancels.length = 0
  mocks.heldContext.length = 0
  mocks.heldGlossary.length = 0
  providerCalls = []
  vi.clearAllMocks()

  mocks.cacheGet.mockResolvedValue(undefined)
  mocks.ensureInitializedConfig.mockResolvedValue(backgroundConfig({ rate: 50, capacity: 50 }))
  mocks.executeTranslate.mockImplementation(
    (text: string, _lang: unknown, _provider: unknown, _prompt: unknown, options?: any) => {
      const call: ProviderCall = { text, signal: options?.signal, answer: createDeferred() }
      providerCalls.push(call)
      return call.answer.promise
    },
  )
  setupPageTranslationHandlers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  mocks.shortcutHandler = undefined
})

describe("a standard-provider selection run owns its request", () => {
  it("names a selection owner on the wire, never a page session id, and cancels exactly that owner on close", async () => {
    mountSelection()
    await openTranslation()
    expect(enqueues()).toHaveLength(1)
    const owner = enqueues()[0]!.data.sessionId as string
    expect(owner).toMatch(SELECTION_NAMESPACE)
    expect(owner).not.toBe(PAGE_SESSION)

    await closePopover()

    expect(cancels().map((m) => m.data.sessionId)).toEqual([owner])
  })

  it("gives every run its own owner", async () => {
    mountSelection()
    await openTranslation()
    await regenerate()

    const owners = enqueues().map((m) => m.data.sessionId as string)
    expect(owners).toHaveLength(2)
    expect(owners[0]).toMatch(SELECTION_NAMESPACE)
    expect(owners[1]).toMatch(SELECTION_NAMESPACE)
    expect(owners[0]).not.toBe(owners[1])
  })
})

describe("closing the popover cancels the run", () => {
  it("aborts a request that is on its way to the provider", async () => {
    mountSelection()
    await openTranslation()
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]!.signal?.aborted).toBe(false)

    await closePopover()

    expect(providerCalls[0]!.signal?.aborted).toBe(true)
  })

  it("is not an error and not a failed use: nothing is tracked as a failure and the answer that comes late is dropped", async () => {
    mountSelection()
    await openTranslation()

    await closePopover()
    providerCalls[0]!.answer.resolve("late answer")
    await flush()

    expect(mocks.trackFeatureUsed).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure" }),
    )
    expect(screen.queryByText("late answer")).not.toBeInTheDocument()
  })

  it("sends no request when it is closed while the page context is still being prepared", async () => {
    const context = holdPageContext()
    mountSelection()
    await openTranslation()
    expect(enqueues()).toHaveLength(0)

    await closePopover()
    context.resolve(null)
    await flush()

    expect(enqueues()).toHaveLength(0)
    expect(providerCalls).toHaveLength(0)
  })

  it("sends no request when it is closed while the core is still preparing it (glossary lookup)", async () => {
    const glossary = holdGlossaryLookup()
    mountSelection()
    await openTranslation()
    expect(enqueues()).toHaveLength(0)

    await closePopover()
    glossary.resolve({ terms: [], revision: 0 })
    await flush()

    expect(enqueues()).toHaveLength(0)
    expect(providerCalls).toHaveLength(0)
  })

  it("removes a request that is still waiting in the queue, so it is never started", async () => {
    // One token, refilled once in 100 s: the page paragraph below takes it and the selection waits.
    mocks.ensureInitializedConfig.mockResolvedValue(backgroundConfig({ rate: 0.01, capacity: 1 }))
    mocks.listeners.clear()
    setupPageTranslationHandlers()
    void pageParagraph("a paragraph holding the only token")
    await flush()
    expect(providerCalls).toHaveLength(1)

    mountSelection()
    await openTranslation()
    expect(enqueues()).toHaveLength(1)
    const queued = track(enqueues()[0]!.result)
    expect(providerCalls).toHaveLength(1)
    expect(queued.outcome()).toBeUndefined()

    await closePopover()

    const outcome = queued.outcome()
    expect(outcome?.ok).toBe(false)
    expect(isTranslationCancelledError((outcome as { error: unknown }).error)).toBe(true)
    // Nothing but the paragraph ever reached the provider, and it was left alone.
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]!.signal?.aborted).toBe(false)
  })
})

describe("restarting the run cancels the previous one", () => {
  it("Regenerate aborts the earlier request and the new run is answered by its own request", async () => {
    mountSelection()
    await openTranslation()
    expect(providerCalls).toHaveLength(1)
    // The new run waits on the page context, so its request reaches the background only after the
    // earlier run's cancel has been handled.
    const context = holdPageContext()

    await regenerate()
    expect(providerCalls[0]!.signal?.aborted).toBe(true)
    context.resolve(null)
    await flush()

    expect(providerCalls).toHaveLength(2)
    expect(providerCalls[1]!.signal?.aborted).toBe(false)
    await act(async () => {
      providerCalls[0]!.answer.resolve("answer of the earlier run")
      providerCalls[1]!.answer.resolve("answer of the new run")
    })
    await flush()
    expect(screen.getByText("answer of the new run")).toBeInTheDocument()
    expect(screen.queryByText("answer of the earlier run")).not.toBeInTheDocument()
  })

  it("closing and reopening starts a fresh request instead of reusing the earlier run's", async () => {
    mountSelection()
    await openTranslation()
    await closePopover()
    expect(providerCalls[0]!.signal?.aborted).toBe(true)

    await openTranslation()

    expect(providerCalls).toHaveLength(2)
    expect(providerCalls[1]!.signal?.aborted).toBe(false)
  })
})

describe("selection runs and page translation do not cancel each other", () => {
  it("a page stop leaves an in-flight selection translation running", async () => {
    mountSelection()
    const page = track(pageParagraph("a paragraph of the page"))
    await flush()
    await openTranslation()
    expect(providerCalls).toHaveLength(2)

    await mocks.bus("cancelPageTranslationRequests", { sessionId: PAGE_SESSION })
    await flush()

    const [pageCall, selectionCall] = providerCalls
    expect(pageCall!.signal?.aborted).toBe(true)
    expect(selectionCall!.signal?.aborted).toBe(false)
    await act(async () => {
      selectionCall!.answer.resolve("the selection's answer")
    })
    await flush()
    expect(screen.getByText("the selection's answer")).toBeInTheDocument()
    expect(isTranslationCancelledError((page.outcome() as { error: unknown }).error)).toBe(true)
  })

  it("closing or restarting the selection leaves the page's requests running", async () => {
    mountSelection()
    const page = track(pageParagraph("a paragraph of the page"))
    await flush()
    await openTranslation()
    expect(providerCalls).toHaveLength(2)
    const pageCall = providerCalls[0]!

    await regenerate()
    await closePopover()

    expect(pageCall.signal?.aborted).toBe(false)
    await act(async () => {
      pageCall.answer.resolve("the page's answer")
    })
    await flush()
    expect(page.outcome()).toEqual({ ok: true, value: "the page's answer" })
  })

  it("closing the selection cancels the selection's own request and only that one", async () => {
    mountSelection()
    const page = track(pageParagraph("a paragraph of the page"))
    await flush()
    await openTranslation()
    const [pageCall, selectionCall] = providerCalls

    await closePopover()

    expect(selectionCall!.signal?.aborted).toBe(true)
    expect(pageCall!.signal?.aborted).toBe(false)
    expect(page.outcome()).toBeUndefined()
  })
})

describe("a task another owner still wants keeps running (the shared-owner contract)", () => {
  it("Regenerate's second run attaches to the first run's in-flight task; the first run's cancel only detaches it", async () => {
    mountSelection()
    await openTranslation()
    expect(providerCalls).toHaveLength(1)

    // The earlier run's cancel is handled only after the new run's request has joined the task.
    mocks.hold.cancels = true
    await regenerate()
    expect(enqueues()).toHaveLength(2)
    await act(async () => {
      for (const deliver of mocks.hold.heldCancels.splice(0)) deliver()
    })
    await flush()

    // One request, shared by both runs; the cancel of the first, if there is one, did not abort it.
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]!.signal?.aborted).toBe(false)
    await act(async () => {
      providerCalls[0]!.answer.resolve("the shared answer")
    })
    await flush()
    expect(screen.getByText("the shared answer")).toBeInTheDocument()
  })

  it("closing the popover then cancels the last owner and aborts the shared task", async () => {
    mountSelection()
    await openTranslation()
    mocks.hold.cancels = true
    await regenerate()
    await act(async () => {
      for (const deliver of mocks.hold.heldCancels.splice(0)) deliver()
    })
    await flush()
    mocks.hold.cancels = false
    expect(providerCalls[0]!.signal?.aborted).toBe(false)

    await closePopover()

    expect(providerCalls[0]!.signal?.aborted).toBe(true)
  })

  it("a request of a sender with no owner for the same text pins the task", async () => {
    mountSelection()
    await openTranslation()
    const hash = enqueues()[0]!.data.hash as string
    // An older content script (no owner) asks for the very same text.
    void mocks.bus("enqueueTranslateRequest", {
      ...enqueues()[0]!.data,
      hash,
      sessionId: undefined,
    })
    await flush()

    await closePopover()

    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0]!.signal?.aborted).toBe(false)
  })
})

describe("what the background remembers of a cancelled run does not decide whether it sends", () => {
  it("a run closed while it was being prepared stays silent after the background has long forgotten its cancel", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const glossary = holdGlossaryLookup()
    mountSelection()
    await openTranslation()
    await closePopover()
    expect(cancels()).toHaveLength(1)

    // Past the registry's time-to-live, and enough other cancels to push the entry out by size too.
    vi.setSystemTime(Date.now() + 11 * 60_000)
    for (let i = 0; i < 300; i++) {
      void mocks.bus("cancelPageTranslationRequests", { sessionId: `selection:other-${i}` })
    }
    await flush()
    glossary.resolve({ terms: [], revision: 0 })
    await flush()

    expect(enqueues()).toHaveLength(0)
    expect(providerCalls).toHaveLength(0)
  })
})
