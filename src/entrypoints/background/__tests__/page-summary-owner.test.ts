import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { DEFAULT_CONFIG } from "@/utils/constants/config"

/**
 * Who owns a page's smart-context summary request in the background.
 *
 * The summary is optional context for the page's paragraphs. A page that asked for it (the user
 * turned smart context on) owns it through its translation session: stopping that session, or
 * closing its tab, must end the summary the same way it ends the session's paragraph requests.
 * A summary several paragraphs or several tabs share keeps running until the last of them leaves,
 * and a request with no session (an older content script, the selection toolbar) pins it.
 *
 * Drives the real `getOrGenerateWebPageSummary` and `cancelPageTranslationRequests` handlers, the
 * real RequestQueue and the real summary code. Only the provider edge (`generateTextForProviderRef`),
 * the config and cache storage and the message registry are replaced.
 *
 * Tabs: 1 and 2 are normal tabs, 3 is a private-window tab, NO_TAB has no tab at all.
 */

const messageHandlers = vi.hoisted(() => new Map<string, (message: unknown) => Promise<unknown>>())
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const generateTextMock = vi.fn<(...args: any[]) => any>()
const articleSummaryGetMock = vi.fn<(...args: any[]) => any>()
const articleSummaryPutMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: (type: string, handler: (message: unknown) => Promise<unknown>) => {
    messageHandlers.set(type, handler)
  },
}))
vi.mock("../config", () => ({ ensureInitializedConfig: ensureInitializedConfigMock }))
vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: vi.fn<() => undefined>(),
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: vi.fn<() => undefined>(),
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: { get: articleSummaryGetMock, put: articleSummaryPutMock },
    translationCache: {
      delete: vi.fn<() => undefined>(),
      get: vi.fn<() => undefined>(),
      put: vi.fn<() => undefined>(),
    },
  },
}))
vi.mock("../background-stream", () => ({
  runStreamTextInBackground: vi.fn<() => undefined>(),
  generateTextForProviderRef: generateTextMock,
}))

const llmProvider: LLMProviderConfig = {
  id: "openai-default",
  name: "OpenAI",
  provider: "openai",
  enabled: true,
  apiKey: "sk-test",
  model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
}

type Sender = { tab?: { id?: number; incognito?: boolean } } | undefined
const TAB_1: Sender = { tab: { id: 1 } }
const TAB_2: Sender = { tab: { id: 2 } }
const TAB_3_PRIVATE: Sender = { tab: { id: 3, incognito: true } }
const NO_TAB: Sender = {}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface SummaryCall {
  signal: AbortSignal | undefined
  prompt: string
}

let calls: SummaryCall[]
/** What the next provider call answers; set per test. */
let answer: (call: SummaryCall) => Promise<string>

/** A provider that finishes when told to, and gives up when its request is aborted. */
function heldProvider() {
  const held = createDeferred<string>()
  answer = (call) =>
    new Promise<string>((resolve, reject) => {
      held.promise.then(resolve, reject)
      call.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      )
    })
  return held
}

function configureQueues(requestQueueConfig: { rate: number; capacity: number }) {
  ensureInitializedConfigMock.mockResolvedValue({
    ...DEFAULT_CONFIG,
    pageTranslation: {
      ...DEFAULT_CONFIG.pageTranslation,
      providerId: llmProvider.id,
      requestQueueConfig,
      batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
    },
  })
}

function getHandler(name: string) {
  const handler = messageHandlers.get(name)
  if (!handler) throw new Error(`Message handler not registered: ${name}`)
  return (message: { data: Record<string, unknown>; sender?: Sender }) => handler(message)
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

function settle(promise: Promise<unknown>): { outcome: () => Outcome | undefined } {
  let result: Outcome | undefined
  promise.then(
    (value) => {
      result = { ok: true, value }
    },
    (error: unknown) => {
      result = { ok: false, error }
    },
  )
  return { outcome: () => result }
}

async function setup() {
  const { setupPageTranslationHandlers } = await import("../page-translation")
  setupPageTranslationHandlers()
  const summary = getHandler("getOrGenerateWebPageSummary")
  const cancel = getHandler("cancelPageTranslationRequests")

  /** `sessionId` undefined sends no session at all, like an older content script or the selection toolbar. */
  const requestSummary = (
    sessionId: string | undefined,
    sender: Sender,
    page: { title?: string; content?: string } = {},
  ) =>
    settle(
      summary({
        data: {
          webTitle: page.title ?? "Page title",
          webContent: page.content ?? "Page body that is long enough to summarise.",
          providerRef: { kind: "local", config: llmProvider },
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        sender,
      }),
    )

  const stopSession = (sessionId: string, sender: Sender) =>
    cancel({ data: { sessionId }, sender }).then(() => vi.advanceTimersByTimeAsync(0))

  const closeTab = async (tabId: number) => {
    await fakeBrowser.tabs.onRemoved.trigger(tabId, { windowId: 1, isWindowClosing: false })
    await vi.advanceTimersByTimeAsync(0)
  }

  return { requestSummary, stopSession, closeTab }
}

/** Let the handler get past the cache lookup and the queue. */
async function settleStart() {
  await vi.advanceTimersByTimeAsync(10)
}

describe("a page's smart-context summary request has an owner", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    fakeBrowser.reset()
    messageHandlers.clear()
    calls = []
    answer = () => Promise.resolve("a summary")
    configureQueues({ rate: 100, capacity: 100 })
    articleSummaryGetMock.mockResolvedValue(undefined)
    articleSummaryPutMock.mockResolvedValue(undefined)
    generateTextMock.mockImplementation((payload: any, options?: any) => {
      const call: SummaryCall = { signal: options?.signal, prompt: String(payload?.prompt ?? "") }
      calls.push(call)
      return answer(call)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("positive controls: what must not change", () => {
    it("generates a summary once and stores it under its key", async () => {
      const { requestSummary } = await setup()

      const summary = requestSummary("s1", TAB_1)
      await settleStart()

      expect(summary.outcome()).toEqual({ ok: true, value: "a summary" })
      expect(calls).toHaveLength(1)
      expect(articleSummaryPutMock).toHaveBeenCalledTimes(1)
    })

    it("serves a cached summary without any provider call", async () => {
      articleSummaryGetMock.mockResolvedValue({ key: "k", summary: "cached summary" })
      const { requestSummary } = await setup()

      const summary = requestSummary("s1", TAB_1)
      await settleStart()

      expect(summary.outcome()).toEqual({ ok: true, value: "cached summary" })
      expect(calls).toHaveLength(0)
    })

    it("two paragraphs of one session share one provider call", async () => {
      const { requestSummary } = await setup()
      const held = heldProvider()
      const first = requestSummary("s1", TAB_1)
      const second = requestSummary("s1", TAB_1)
      await settleStart()
      expect(calls).toHaveLength(1)

      held.resolve("a summary")
      await settleStart()

      expect(first.outcome()).toEqual({ ok: true, value: "a summary" })
      expect(second.outcome()).toEqual({ ok: true, value: "a summary" })
      expect(calls).toHaveLength(1)
    })

    it("a request with no session (an older content script, the selection toolbar) pins a shared summary", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      const scoped = requestSummary("s1", TAB_1)
      const unscoped = requestSummary(undefined, TAB_2)
      await settleStart()
      expect(calls).toHaveLength(1)

      await stopSession("s1", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("a summary")
      await settleStart()
      expect(unscoped.outcome()).toEqual({ ok: true, value: "a summary" })
      expect(scoped.outcome()).toEqual({ ok: true, value: "a summary" })
    })

    it("a request with no session that joins after the owner pins it too", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      requestSummary("s1", TAB_1)
      await settleStart()
      const unscoped = requestSummary(undefined, TAB_2)
      await settleStart()

      await stopSession("s1", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("a summary")
      await settleStart()
      expect(unscoped.outcome()).toEqual({ ok: true, value: "a summary" })
    })

    it("a session on a sender with no tab cannot be stopped (it is unowned)", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      const summary = requestSummary("s1", NO_TAB)
      await settleStart()

      await stopSession("s1", NO_TAB)

      expect(calls[0]!.signal!.aborted).toBe(false)
      held.resolve("a summary")
      await settleStart()
      expect(summary.outcome()).toEqual({ ok: true, value: "a summary" })
    })

    it("preservation control: one tab stopping does not stop the other tab's summary", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      requestSummary("s1", TAB_1)
      const other = requestSummary("s2", TAB_2)
      await settleStart()
      expect(calls).toHaveLength(1)

      await stopSession("s1", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("a summary")
      await settleStart()
      expect(other.outcome()).toEqual({ ok: true, value: "a summary" })
    })

    it("a stopped session's summary does not take its successor's away", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      requestSummary("s1", TAB_1)
      await settleStart()

      await stopSession("s1", TAB_1)
      const successor = requestSummary("s2", TAB_1)
      held.resolve("a summary")
      await settleStart()
      await vi.advanceTimersByTimeAsync(10)

      expect(successor.outcome()).toEqual({ ok: true, value: "a summary" })
    })

    it("a private-window tab and a normal tab never share a summary, and the private one never touches the cache", async () => {
      const { requestSummary } = await setup()
      const held = heldProvider()
      const normal = requestSummary("s1", TAB_1)
      const privateTab = requestSummary("s3", TAB_3_PRIVATE)
      await settleStart()
      expect(calls).toHaveLength(2)

      held.resolve("a summary")
      await settleStart()

      expect(normal.outcome()).toEqual({ ok: true, value: "a summary" })
      expect(privateTab.outcome()).toEqual({ ok: true, value: "a summary" })
      // One cache read and one write, both for the normal tab.
      expect(articleSummaryGetMock).toHaveBeenCalledTimes(2)
      expect(articleSummaryPutMock).toHaveBeenCalledTimes(1)
    })
  })

  describe("the session stops (or its tab closes): the summary goes with it", () => {
    it("queued behind a busy queue: it is never sent", async () => {
      configureQueues({ rate: 1, capacity: 1 })
      const { requestSummary, stopSession } = await setup()
      const busy = heldProvider()
      requestSummary("s2", TAB_2, { title: "Another page", content: "Another body to summarise." })
      await settleStart()
      expect(calls).toHaveLength(1)

      const waiting = requestSummary("s1", TAB_1)
      await settleStart()
      expect(calls).toHaveLength(1)

      await stopSession("s1", TAB_1)
      busy.resolve("a summary")
      await vi.advanceTimersByTimeAsync(10_000)

      expect(calls).toHaveLength(1)
      // The caller gets no summary and carries on; a summary is optional context.
      expect(waiting.outcome()).toEqual({ ok: true, value: null })
    })

    it("in flight: the provider request is aborted", async () => {
      const { requestSummary, stopSession } = await setup()
      heldProvider()
      const summary = requestSummary("s1", TAB_1)
      await settleStart()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await stopSession("s1", TAB_1)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expect(summary.outcome()).toEqual({ ok: true, value: null })
    })

    it("suspended on the first cache lookup: it does not start afterwards", async () => {
      const lookup = createDeferred<undefined>()
      articleSummaryGetMock.mockReturnValue(lookup.promise)
      const { requestSummary, stopSession } = await setup()
      const summary = requestSummary("s1", TAB_1)
      await settleStart()

      await stopSession("s1", TAB_1)
      lookup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expect(summary.outcome()).toEqual({ ok: true, value: null })
    })

    it("suspended on the second cache lookup, inside the queued task: the provider is not called", async () => {
      const lookup = createDeferred<undefined>()
      articleSummaryGetMock.mockResolvedValueOnce(undefined).mockReturnValueOnce(lookup.promise)
      const { requestSummary, stopSession } = await setup()
      const summary = requestSummary("s1", TAB_1)
      await settleStart()
      expect(articleSummaryGetMock).toHaveBeenCalledTimes(2)

      await stopSession("s1", TAB_1)
      lookup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expect(summary.outcome()).toEqual({ ok: true, value: null })
    })

    it("waiting for a retry after a timeout: no further attempt", async () => {
      const { requestSummary, stopSession } = await setup()
      // Never answers and ignores the abort: only the queue's own 20 s timeout ends the attempt.
      answer = () => new Promise<string>(() => {})
      requestSummary("s1", TAB_1)
      await settleStart()
      expect(calls).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(20_500)
      // The attempt timed out and the task sleeps before its retry.
      expect(calls).toHaveLength(1)

      await stopSession("s1", TAB_1)
      await vi.advanceTimersByTimeAsync(120_000)

      expect(calls).toHaveLength(1)
    })

    it("the cancel arrives while the request still waits for the queue configuration (a cold worker)", async () => {
      const configuration = createDeferred<unknown>()
      ensureInitializedConfigMock.mockReturnValue(configuration.promise)
      const { requestSummary } = await setup()
      const summary = requestSummary("s1", TAB_1)
      await settleStart()

      // Sent without waiting for it: the cancel handler itself waits for the queues too.
      const cancelling = getHandler("cancelPageTranslationRequests")({
        data: { sessionId: "s1" },
        sender: TAB_1,
      })
      await settleStart()
      configuration.resolve({
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: llmProvider.id,
          requestQueueConfig: { rate: 100, capacity: 100 },
          batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
        },
      })
      await cancelling
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expect(summary.outcome()).toEqual({ ok: true, value: null })
    })

    it("a request of a session that already stopped is refused", async () => {
      const { requestSummary, stopSession } = await setup()
      await stopSession("s1", TAB_1)

      const late = requestSummary("s1", TAB_1)
      await settleStart()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expect(late.outcome()).toEqual({ ok: true, value: null })
    })

    it("a cached summary is still served to a session that stopped (no provider work is involved)", async () => {
      articleSummaryGetMock.mockResolvedValue({ key: "k", summary: "cached summary" })
      const { requestSummary, stopSession } = await setup()
      await stopSession("s1", TAB_1)

      const late = requestSummary("s1", TAB_1)
      await settleStart()

      expect(late.outcome()).toEqual({ ok: true, value: "cached summary" })
      expect(calls).toHaveLength(0)
    })

    it("tab close, in flight: the provider request is aborted", async () => {
      const { requestSummary, closeTab } = await setup()
      heldProvider()
      const summary = requestSummary("s1", { tab: { id: 7 } })
      await settleStart()
      expect(calls).toHaveLength(1)

      await closeTab(7)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expect(summary.outcome()).toEqual({ ok: true, value: null })
    })

    it("tab close, a different tab's identical summary keeps running", async () => {
      const { requestSummary, closeTab } = await setup()
      const held = heldProvider()
      requestSummary("s1", { tab: { id: 7 } })
      const other = requestSummary("s2", TAB_2)
      await settleStart()

      await closeTab(7)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("a summary")
      await settleStart()
      expect(other.outcome()).toEqual({ ok: true, value: "a summary" })
    })
  })

  describe("a summary shared by several owners keeps running until the last one leaves", () => {
    it("two paragraphs of one session: stopping the session aborts the one task", async () => {
      const { requestSummary, stopSession } = await setup()
      heldProvider()
      requestSummary("s1", TAB_1)
      requestSummary("s1", TAB_1)
      await settleStart()
      expect(calls).toHaveLength(1)

      await stopSession("s1", TAB_1)

      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("two tabs: the first stopping detaches, the second stopping aborts", async () => {
      const { requestSummary, stopSession } = await setup()
      heldProvider()
      const first = requestSummary("s1", TAB_1)
      const second = requestSummary("s2", TAB_2)
      await settleStart()
      expect(calls).toHaveLength(1)

      await stopSession("s1", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await stopSession("s2", TAB_2)
      expect(calls[0]!.signal!.aborted).toBe(true)
      expect(first.outcome()).toEqual({ ok: true, value: null })
      expect(second.outcome()).toEqual({ ok: true, value: null })
    })

    it("the order does not matter: the second tab stopping first leaves the task to the first", async () => {
      const { requestSummary, stopSession } = await setup()
      heldProvider()
      requestSummary("s1", TAB_1)
      requestSummary("s2", TAB_2)
      await settleStart()

      await stopSession("s2", TAB_2)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await stopSession("s1", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("two sessions of one tab are two owners", async () => {
      const { requestSummary, stopSession } = await setup()
      heldProvider()
      requestSummary("s1", TAB_1)
      requestSummary("s2", TAB_1)
      await settleStart()

      await stopSession("s1", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await stopSession("s2", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("stopping a normal tab's session leaves a private tab's identical summary running", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      requestSummary("s1", TAB_1)
      const privateTab = requestSummary("s3", TAB_3_PRIVATE)
      await settleStart()
      expect(calls).toHaveLength(2)

      await stopSession("s1", TAB_1)

      expect(calls.filter((call) => call.signal!.aborted)).toHaveLength(1)
      held.resolve("a summary")
      await settleStart()
      expect(privateTab.outcome()).toEqual({ ok: true, value: "a summary" })
    })

    it("a cancel of one session does not take the summary away from a paragraph request that joined later", async () => {
      const { requestSummary, stopSession } = await setup()
      const held = heldProvider()
      requestSummary("s1", TAB_1)
      await settleStart()
      const joined = requestSummary("s2", TAB_2)
      await settleStart()

      await stopSession("s1", TAB_1)
      held.resolve("a summary")
      await settleStart()

      expect(joined.outcome()).toEqual({ ok: true, value: "a summary" })
    })
  })
})
