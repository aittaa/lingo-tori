import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

/**
 * What a standard-provider selection run relies on from the background: a request owned by
 * `selection:<random>` (carried as the existing `sessionId`) is queued, drained and shared exactly
 * like a page session's, in a scope of its own. The real `enqueueTranslateRequest` /
 * `cancelPageTranslationRequests` handlers, RequestQueue and cancelled-scope registry run as in
 * production; only the provider edge (`executeTranslate`), storage and the message transport are
 * replaced. These hold without any background change.
 *
 * Tabs: 7 and 8. "P" is a page session of tab 7; "selection:run-a/b" are selection runs.
 */

const onMessageMock = vi.fn<(...args: any[]) => any>()
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const executeTranslateMock = vi.fn<(...args: any[]) => any>()
const translationCacheGetMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({ onMessage: onMessageMock }))
vi.mock("../config", () => ({ ensureInitializedConfig: ensureInitializedConfigMock }))
vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: executeTranslateMock,
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: vi.fn<() => undefined>(),
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: { get: vi.fn<() => undefined>(), put: vi.fn<() => undefined>() },
    translationCache: {
      delete: vi.fn<() => undefined>(),
      get: translationCacheGetMock,
      put: vi.fn<() => undefined>(),
    },
  },
}))
vi.mock("../background-stream", () => ({
  runStreamTextInBackground: vi.fn<() => undefined>(),
  generateTextForProviderRef: vi.fn<() => undefined>(),
}))

const provider = {
  ...structuredClone(DEFAULT_PROVIDER_CONFIG.deepl),
  id: "deepl-test",
  name: "DeepL",
  enabled: true,
  apiKey: "test-key",
}

type Sender = { tab?: { id?: number } } | undefined
const TAB_7: Sender = { tab: { id: 7 } }
const TAB_8: Sender = { tab: { id: 8 } }
const UNSCOPED: Sender = {}

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

interface ProviderCall {
  text: string
  signal: AbortSignal | undefined
  answer: Deferred<string>
}
let calls: ProviderCall[]

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

function getHandler(name: string) {
  const registration = onMessageMock.mock.calls.find((call) => call[0] === name)
  if (!registration) throw new Error(`Message handler not registered: ${name}`)
  const handler = registration[1] as (message: unknown) => Promise<unknown>
  return (message: { data: Record<string, unknown>; sender?: Sender }) => handler(message)
}

function configureQueue(requestQueueConfig: { rate: number; capacity: number }) {
  ensureInitializedConfigMock.mockResolvedValue({
    ...DEFAULT_CONFIG,
    pageTranslation: {
      ...DEFAULT_CONFIG.pageTranslation,
      providerId: provider.id,
      requestQueueConfig,
    },
  })
}

async function setup() {
  const { setupPageTranslationHandlers } = await import("../page-translation")
  setupPageTranslationHandlers()
  const enqueue = getHandler("enqueueTranslateRequest")
  const cancel = getHandler("cancelPageTranslationRequests")
  const request = (text: string, hash: string, sessionId: string | undefined, sender: Sender) =>
    settle(
      enqueue({
        data: {
          text,
          usageFeature: "selectionTranslation",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local", config: provider },
          scheduleAt: Date.now(),
          hash,
          sessionId,
        },
        sender,
      }),
    )
  const cancelOwner = (sessionId: string, sender: Sender) =>
    cancel({ data: { sessionId }, sender }).then(() => vi.advanceTimersByTimeAsync(0))
  return { request, cancelOwner }
}

describe("selection owners in the background queue", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    calls = []
    configureQueue({ rate: 100, capacity: 100 })
    translationCacheGetMock.mockResolvedValue(undefined)
    executeTranslateMock.mockImplementation(
      (text: string, _lang: unknown, _provider: unknown, _prompt: unknown, options?: any) => {
        const call: ProviderCall = {
          text,
          signal: options?.signal,
          answer: createDeferred(),
        }
        calls.push(call)
        return call.answer.promise
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("a scope of their own", () => {
    it("a page stop does not drain a selection owner's request of the same tab", async () => {
      const { request, cancelOwner } = await setup()
      const page = request("page text", "h-page", "P", TAB_7)
      const selection = request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(2)

      await cancelOwner("P", TAB_7)

      expect(calls[0]!.signal?.aborted).toBe(true)
      expect(calls[1]!.signal?.aborted).toBe(false)
      expect(page.outcome()?.ok).toBe(false)
      calls[1]!.answer.resolve("selection translated")
      await vi.advanceTimersByTimeAsync(0)
      expect(selection.outcome()).toEqual({ ok: true, value: "selection translated" })
    })

    it("cancelling a selection owner does not drain the page session's request", async () => {
      const { request, cancelOwner } = await setup()
      const page = request("page text", "h-page", "P", TAB_7)
      request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)

      await cancelOwner("selection:run-a", TAB_7)

      expect(calls[1]!.signal?.aborted).toBe(true)
      expect(calls[0]!.signal?.aborted).toBe(false)
      calls[0]!.answer.resolve("page translated")
      await vi.advanceTimersByTimeAsync(0)
      expect(page.outcome()).toEqual({ ok: true, value: "page translated" })
    })

    it("another tab cannot cancel a selection owner, even with the same owner id", async () => {
      const { request, cancelOwner } = await setup()
      request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)

      await cancelOwner("selection:run-a", TAB_8)

      expect(calls[0]!.signal?.aborted).toBe(false)
    })

    it("closing the tab drains its selection owners and leaves the other tab's", async () => {
      const { request } = await setup()
      const closing = request("selection text", "h-one", "selection:run-a", TAB_7)
      request("selection text 2", "h-two", "selection:run-b", TAB_8)
      await vi.advanceTimersByTimeAsync(0)

      await fakeBrowser.tabs.onRemoved.trigger(7, { windowId: 1, isWindowClosing: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(calls[0]!.signal?.aborted).toBe(true)
      expect(calls[1]!.signal?.aborted).toBe(false)
      expect(isTranslationCancelledError((closing.outcome() as { error: unknown }).error)).toBe(
        true,
      )
    })
  })

  describe("queued and in flight", () => {
    it("a request waiting behind the only token is removed by its owner's cancel and never started", async () => {
      configureQueue({ rate: 0.01, capacity: 1 })
      const { request, cancelOwner } = await setup()
      request("blocker", "h-blocker", "P", TAB_7)
      const queued = request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.map((call) => call.text)).toEqual(["blocker"])

      await cancelOwner("selection:run-a", TAB_7)

      const outcome = queued.outcome()
      expect(outcome?.ok).toBe(false)
      expect(isTranslationCancelledError((outcome as { error: unknown }).error)).toBe(true)
      // Far past the token's refill (the unanswered blocker times out and retries meanwhile): the
      // removed request is never dispatched.
      await vi.advanceTimersByTimeAsync(200_000)
      expect(calls.filter((call) => call.text === "selection text")).toHaveLength(0)
    })

    it("an in-flight request's provider signal is aborted by its owner's cancel", async () => {
      const { request, cancelOwner } = await setup()
      const inFlight = request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls[0]!.signal?.aborted).toBe(false)

      await cancelOwner("selection:run-a", TAB_7)

      expect(calls[0]!.signal?.aborted).toBe(true)
      expect(isTranslationCancelledError((inFlight.outcome() as { error: unknown }).error)).toBe(
        true,
      )
    })
  })

  describe("a request another owner still wants keeps running (shared-owner contract)", () => {
    it("two runs asking for the same text share one request; cancelling one leaves it, cancelling both aborts it", async () => {
      const { request, cancelOwner } = await setup()
      const first = request("same text", "h-same", "selection:run-a", TAB_7)
      const second = request("same text", "h-same", "selection:run-b", TAB_7)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(1)

      await cancelOwner("selection:run-a", TAB_7)
      expect(calls[0]!.signal?.aborted).toBe(false)
      expect(first.outcome()).toBeUndefined()

      await cancelOwner("selection:run-b", TAB_7)
      expect(calls[0]!.signal?.aborted).toBe(true)
      expect(second.outcome()?.ok).toBe(false)
    })

    it("the same text opened in two tabs is one request; one tab's cancel leaves it to the other", async () => {
      const { request, cancelOwner } = await setup()
      request("same text", "h-same", "selection:run-a", TAB_7)
      const other = request("same text", "h-same", "selection:run-c", TAB_8)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(1)

      await cancelOwner("selection:run-a", TAB_7)
      expect(calls[0]!.signal?.aborted).toBe(false)
      calls[0]!.answer.resolve("shared translation")
      await vi.advanceTimersByTimeAsync(0)
      expect(other.outcome()).toEqual({ ok: true, value: "shared translation" })
    })

    it("a sender with no owner for the same text pins the request whoever else cancels", async () => {
      const { request, cancelOwner } = await setup()
      request("same text", "h-same", "selection:run-a", TAB_7)
      request("same text", "h-same", undefined, UNSCOPED)
      await vi.advanceTimersByTimeAsync(0)

      await cancelOwner("selection:run-a", TAB_7)

      expect(calls).toHaveLength(1)
      expect(calls[0]!.signal?.aborted).toBe(false)
    })
  })

  describe("a cancel that arrives while the enqueue is still reading the cache", () => {
    it("is not lost: the request is refused when the lookup returns and the provider is never called", async () => {
      const lookup = createDeferred<undefined>()
      translationCacheGetMock.mockReturnValueOnce(lookup.promise)
      const { request, cancelOwner } = await setup()
      const suspended = request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)

      await cancelOwner("selection:run-a", TAB_7)
      lookup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)

      const outcome = suspended.outcome()
      expect(outcome?.ok).toBe(false)
      expect(isTranslationCancelledError((outcome as { error: unknown }).error)).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  describe("how long the background remembers a cancelled owner (registry capacity)", () => {
    // The registry keeps a cancelled scope for ten minutes and at most 256 of them. The content side
    // sends nothing for an owner that cancelled before the send. It cannot stop a request that is
    // already inside the background awaiting its cache or queue configuration, though: that wait is
    // not guaranteed to be short, and if the cancel is evicted before it ends (capacity eviction by
    // 256 later unique cancels, or the TTL), the background takes the request. It still carries its
    // tab/run scope, so if the tab is closed afterwards that close drains it; a close that already
    // happened gives no such guarantee. This is an inherited limit of the bounded registry, not
    // something this change rules out. These tests pin both sides of it.
    it("refuses a late request while the cancel is still remembered, however many other owners cancelled since (under the cap)", async () => {
      const lookup = createDeferred<undefined>()
      translationCacheGetMock.mockReturnValueOnce(lookup.promise)
      const { request, cancelOwner } = await setup()
      const suspended = request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)

      await cancelOwner("selection:run-a", TAB_7)
      for (let i = 0; i < 200; i++) await cancelOwner(`selection:other-${i}`, TAB_7)
      lookup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(suspended.outcome()?.ok).toBe(false)
      expect(calls).toHaveLength(0)
    })

    it("boundary: once the registry has dropped a cancelled owner (past 256 newer cancels, or its ten minutes) the background alone can no longer refuse a request for it", async () => {
      const lookup = createDeferred<undefined>()
      translationCacheGetMock.mockReturnValueOnce(lookup.promise)
      const { request, cancelOwner } = await setup()
      request("selection text", "h-selection", "selection:run-a", TAB_7)
      await vi.advanceTimersByTimeAsync(0)

      await cancelOwner("selection:run-a", TAB_7)
      for (let i = 0; i < 300; i++) await cancelOwner(`selection:other-${i}`, TAB_7)
      lookup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)

      // The scope was pushed out of the registry, so the background took the request. The content
      // side's own gate (see the provider test "stays silent after the background has long forgotten
      // its cancel") only covers a cancel that happened before the send. A request that was already
      // waiting here, as this one was, runs once its cancel is evicted, and keeps its tab/run scope.
      expect(calls).toHaveLength(1)
    })
  })
})
