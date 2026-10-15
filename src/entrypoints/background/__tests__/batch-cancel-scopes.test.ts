import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

/**
 * Cancellation ownership of a batch that is deduped across sessions, drives the real
 * `enqueueTranslateRequest` / `cancelPageTranslationRequests` handlers, the real BatchQueue and the
 * real RequestQueue, wired exactly as in production. Only the provider edge (`executeTranslate`),
 * storage and the message transport are replaced.
 *
 * Sessions: A is tab 1, B is tab 2, U is a sender without a tab (unscoped, so it cannot cancel).
 * "alpha" is requested by both A and B (or U) before the flush, so one BatchTask carries both.
 */

const onMessageMock = vi.fn<(...args: any[]) => any>()
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const executeTranslateMock = vi.fn<(...args: any[]) => any>()
const putBatchRequestRecordMock = vi.fn<(...args: any[]) => any>()
const translationCacheGetMock = vi.fn<(...args: any[]) => any>()
const translationCachePutMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({ onMessage: onMessageMock }))
vi.mock("../config", () => ({ ensureInitializedConfig: ensureInitializedConfigMock }))
vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: executeTranslateMock,
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: putBatchRequestRecordMock,
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: { get: vi.fn<() => undefined>(), put: vi.fn<() => undefined>() },
    translationCache: {
      delete: vi.fn<() => undefined>(),
      get: translationCacheGetMock,
      put: translationCachePutMock,
    },
  },
}))
vi.mock("../background-stream", () => ({
  runStreamTextInBackground: vi.fn<() => undefined>(),
  generateTextForProviderRef: vi.fn<() => undefined>(),
}))

const llmProvider: LLMProviderConfig = {
  id: "openai-default",
  name: "OpenAI",
  provider: "openai",
  enabled: true,
  apiKey: "sk-test",
  model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
}

type Sender = { tab?: { id?: number } } | undefined
const TAB_A: Sender = { tab: { id: 1 } }
const TAB_B: Sender = { tab: { id: 2 } }
const UNSCOPED: Sender = {}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface ProviderCall {
  text: string
  signal: AbortSignal | undefined
  isBatch: boolean
}

let calls: ProviderCall[]
/** What the next provider call answers; set per test. */
let answer: (call: ProviderCall) => Promise<string>

function mismatch(): Promise<string> {
  return Promise.resolve("only one segment")
}

function correctBatch(call: ProviderCall): Promise<string> {
  const items = call.text.split(`\n\n${BATCH_SEPARATOR}\n\n`)
  return Promise.resolve(
    items.map((item) => `translated ${item}`).join(`\n\n${BATCH_SEPARATOR}\n\n`),
  )
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
  const registration = onMessageMock.mock.calls.find((call) => call[0] === name)
  if (!registration) throw new Error(`Message handler not registered: ${name}`)
  const handler = registration[1] as (message: unknown) => Promise<unknown>
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
  const enqueue = getHandler("enqueueTranslateRequest")
  const cancel = getHandler("cancelPageTranslationRequests")

  const request = (text: string, hash: string, sessionId: string, sender: Sender) =>
    settle(
      enqueue({
        data: {
          text,
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local", config: llmProvider },
          scheduleAt: Date.now(),
          hash,
          sessionId,
        },
        sender,
      }),
    )
  const cancelSession = (sessionId: string, sender: Sender) =>
    cancel({ data: { sessionId }, sender }).then(() => vi.advanceTimersByTimeAsync(0))

  return { request, cancelSession }
}

const BATCH_DELAY_MS = 100
// 1s + 2s + 4s of backoff, one per mismatch retry, before the individual fallback starts.
const ALL_RETRY_BACKOFFS_MS = 7_000

async function flush() {
  await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + 50)
}

const batchCalls = () => calls.filter((call) => call.isBatch)
const individualCalls = (text: string) =>
  calls.filter((call) => !call.isBatch && call.text === text)

describe("batch cancellation ownership across deduped sessions", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    calls = []
    answer = mismatch
    configureQueues({ rate: 100, capacity: 100 })
    putBatchRequestRecordMock.mockResolvedValue(undefined)
    translationCacheGetMock.mockResolvedValue(undefined)
    translationCachePutMock.mockResolvedValue(undefined)
    executeTranslateMock.mockImplementation(
      (text: string, _lang: unknown, _provider: unknown, _prompt: unknown, options?: any) => {
        const call: ProviderCall = {
          text,
          signal: options?.signal,
          isBatch: text.includes(BATCH_SEPARATOR),
        }
        calls.push(call)
        return answer(call)
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("C01: the individual fallback of a deduped task", () => {
    /**
     * A asks for alpha and beta, B asks for alpha, all before the flush. Every batch attempt
     * comes back one segment short, so after the backoffs alpha (owned by A and B) and beta (A
     * only) are each re-sent alone. Alpha's single call is then held open.
     */
    async function reachHeldFallback() {
      const ctx = await setup()
      const held = createDeferred<string>()
      answer = (call) => {
        if (call.isBatch) return mismatch()
        return call.text === "alpha" ? held.promise : Promise.resolve(`translated ${call.text}`)
      }
      const alphaA = ctx.request("alpha", "h-alpha", "sA", TAB_A)
      const betaA = ctx.request("beta", "h-beta", "sA", TAB_A)
      const alphaB = ctx.request("alpha", "h-alpha", "sB", TAB_B)
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(0)

      await flush()
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)
      expect(batchCalls()).toHaveLength(4)
      expect(individualCalls("alpha")).toHaveLength(1)
      return { ...ctx, held, alphaA, betaA, alphaB }
    }

    it("cancelling A does not take the shared fallback away from B", async () => {
      const { cancelSession, held, alphaB } = await reachHeldFallback()
      const fallbackSignal = individualCalls("alpha")[0]!.signal!

      await cancelSession("sA", TAB_A)

      expect(fallbackSignal.aborted).toBe(false)
      held.resolve("translated alpha")
      await vi.advanceTimersByTimeAsync(10)
      expect(alphaB.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })

    it("cancelling B as well, the last owner, aborts the fallback with no further attempt", async () => {
      const { cancelSession, alphaB } = await reachHeldFallback()
      const fallbackSignal = individualCalls("alpha")[0]!.signal!
      await cancelSession("sA", TAB_A)
      expect(fallbackSignal.aborted).toBe(false)
      const attemptsBefore = calls.length

      await cancelSession("sB", TAB_B)

      expect(fallbackSignal.aborted).toBe(true)
      const result = alphaB.outcome()
      expect(result?.ok).toBe(false)
      expect(isTranslationCancelledError((result as { error: unknown }).error)).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toHaveLength(attemptsBefore)
    })

    it("cancelling B first leaves the fallback to A, and cancelling A then aborts it", async () => {
      const { cancelSession } = await reachHeldFallback()
      const fallbackSignal = individualCalls("alpha")[0]!.signal!

      await cancelSession("sB", TAB_B)
      expect(fallbackSignal.aborted).toBe(false)

      await cancelSession("sA", TAB_A)
      expect(fallbackSignal.aborted).toBe(true)
    })

    it("an unscoped subscriber keeps the fallback alive whoever else cancels", async () => {
      const ctx = await setup()
      const held = createDeferred<string>()
      answer = (call) => {
        if (call.isBatch) return mismatch()
        return call.text === "alpha" ? held.promise : Promise.resolve(`translated ${call.text}`)
      }
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      ctx.request("beta", "h-beta", "sA", TAB_A)
      ctx.request("alpha", "h-alpha", "sB", TAB_B)
      const unscoped = ctx.request("alpha", "h-alpha", "sU", UNSCOPED)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)
      const fallbackSignal = individualCalls("alpha")[0]!.signal!

      await ctx.cancelSession("sA", TAB_A)
      await ctx.cancelSession("sB", TAB_B)

      expect(fallbackSignal.aborted).toBe(false)
      held.resolve("translated alpha")
      await vi.advanceTimersByTimeAsync(10)
      expect(unscoped.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })

    it("an unscoped first requester keeps the fallback alive when a scoped one cancels (control)", async () => {
      const ctx = await setup()
      const held = createDeferred<string>()
      answer = (call) => {
        if (call.isBatch) return mismatch()
        return call.text === "alpha" ? held.promise : Promise.resolve(`translated ${call.text}`)
      }
      const unscoped = ctx.request("alpha", "h-alpha", "sU", UNSCOPED)
      ctx.request("beta", "h-beta", "sU", UNSCOPED)
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)
      const fallbackSignal = individualCalls("alpha")[0]!.signal!

      await ctx.cancelSession("sA", TAB_A)

      expect(fallbackSignal.aborted).toBe(false)
      held.resolve("translated alpha")
      await vi.advanceTimersByTimeAsync(10)
      expect(unscoped.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })

    it("a first requester that cancelled before the flush does not own the fallback any more", async () => {
      const ctx = await setup()
      answer = (call) => {
        if (call.isBatch) return mismatch()
        return call.text === "alpha" ? createDeferred<string>().promise : Promise.resolve("x")
      }
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      ctx.request("alpha", "h-alpha", "sB", TAB_B)
      ctx.request("gamma", "h-gamma", "sB", TAB_B)
      await vi.advanceTimersByTimeAsync(10)

      // A cancels while everything is still pending: alpha stays queued for B alone.
      await ctx.cancelSession("sA", TAB_A)
      await flush()
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)
      const fallbackSignal = individualCalls("alpha")[0]!.signal!
      expect(fallbackSignal.aborted).toBe(false)

      await ctx.cancelSession("sB", TAB_B)

      expect(fallbackSignal.aborted).toBe(true)
    })

    it("an item whose every owner cancelled during the backoffs is not sent at all", async () => {
      const ctx = await setup()
      answer = (call) => (call.isBatch ? mismatch() : Promise.resolve(`translated ${call.text}`))
      const betaA = ctx.request("beta", "h-beta", "sA", TAB_A)
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      const alphaB = ctx.request("alpha", "h-alpha", "sB", TAB_B)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      // A cancels in the middle of the backoffs; B stays.
      await vi.advanceTimersByTimeAsync(500)
      await ctx.cancelSession("sA", TAB_A)
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)

      expect(individualCalls("beta")).toHaveLength(0)
      expect(individualCalls("alpha")).toHaveLength(1)
      const beta = betaA.outcome()
      expect(beta?.ok).toBe(false)
      expect(isTranslationCancelledError((beta as { error: unknown }).error)).toBe(true)
      expect(alphaB.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })
  })

  describe("C02: a mismatch retry after a partial cancel", () => {
    /**
     * A asks for alpha and beta, B for alpha. The first attempt comes back one segment short and the
     * batch sleeps its 1s backoff. A cancels in that window, when the batch lives in no queue.
     */
    async function reachRetryAfterPartialCancel(queue: { rate: number; capacity: number }) {
      configureQueues(queue)
      const ctx = await setup()
      const held = createDeferred<string>()
      let attempt = 0
      answer = (call) => {
        if (!call.isBatch) return Promise.resolve(`translated ${call.text}`)
        return ++attempt === 1 ? mismatch() : held.promise
      }
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      ctx.request("beta", "h-beta", "sA", TAB_A)
      const alphaB = ctx.request("alpha", "h-alpha", "sB", TAB_B)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      expect(batchCalls()).toHaveLength(1)

      await ctx.cancelSession("sA", TAB_A)
      return { ...ctx, held, alphaB }
    }

    it("an executing retry lists only the live scope, so the last cancel aborts it", async () => {
      const { cancelSession, alphaB } = await reachRetryAfterPartialCancel({
        rate: 100,
        capacity: 100,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      // B is alive, so the batch is retried and is now executing.
      expect(batchCalls()).toHaveLength(2)
      const retrySignal = batchCalls()[1]!.signal!
      expect(retrySignal.aborted).toBe(false)

      await cancelSession("sB", TAB_B)

      expect(retrySignal.aborted).toBe(true)
      const result = alphaB.outcome()
      expect(result?.ok).toBe(false)
      expect(isTranslationCancelledError((result as { error: unknown }).error)).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toHaveLength(2)
    })

    it("a waiting retry lists only the live scope, so the last cancel removes it from the queue", async () => {
      // One token, refilled once in 20s: the retry has to wait for it.
      const { cancelSession, alphaB } = await reachRetryAfterPartialCancel({
        rate: 0.05,
        capacity: 1,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(batchCalls()).toHaveLength(1)

      await cancelSession("sB", TAB_B)

      const result = alphaB.outcome()
      expect(result?.ok).toBe(false)
      expect(isTranslationCancelledError((result as { error: unknown }).error)).toBe(true)
      // Past the token refill and every later retry window: no provider attempt is made.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(calls).toHaveLength(1)
    })

    it("A alone cancelled: the retry still completes the mixed batch for B (control)", async () => {
      const ctx = await setup()
      let attempt = 0
      answer = (call) => {
        if (!call.isBatch) return Promise.resolve(`translated ${call.text}`)
        return ++attempt === 1 ? mismatch() : correctBatch(call)
      }
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      ctx.request("beta", "h-beta", "sA", TAB_A)
      const alphaB = ctx.request("alpha", "h-alpha", "sB", TAB_B)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      await ctx.cancelSession("sA", TAB_A)

      await vi.advanceTimersByTimeAsync(1_000)

      expect(alphaB.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })

    it("a tab closed during the backoff counts as cancelled, so the retry lists only the other tab", async () => {
      const ctx = await setup()
      const held = createDeferred<string>()
      let attempt = 0
      answer = (call) => {
        if (!call.isBatch) return Promise.resolve(`translated ${call.text}`)
        return ++attempt === 1 ? mismatch() : held.promise
      }
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      ctx.request("beta", "h-beta", "sA", TAB_A)
      const alphaB = ctx.request("alpha", "h-alpha", "sB", TAB_B)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      expect(batchCalls()).toHaveLength(1)

      // Tab 1 closes in the backoff: no cancel message ever arrives, the tab sweep marks its scopes.
      await fakeBrowser.tabs.onRemoved.trigger(1, { windowId: 1, isWindowClosing: false })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(batchCalls()).toHaveLength(2)

      await ctx.cancelSession("sB", TAB_B)

      expect(batchCalls()[1]!.signal!.aborted).toBe(true)
      const result = alphaB.outcome()
      expect(result?.ok).toBe(false)
      expect(isTranslationCancelledError((result as { error: unknown }).error)).toBe(true)
    })

    it("both cancelled during the backoff: no retry is sent (control)", async () => {
      const { cancelSession, alphaB } = await reachRetryAfterPartialCancel({
        rate: 100,
        capacity: 100,
      })
      await cancelSession("sB", TAB_B)

      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)

      expect(calls).toHaveLength(1)
      const result = alphaB.outcome()
      expect(result?.ok).toBe(false)
      expect(isTranslationCancelledError((result as { error: unknown }).error)).toBe(true)
    })

    it("an unscoped subscriber keeps the retry alive after A and B cancel", async () => {
      configureQueues({ rate: 100, capacity: 100 })
      const ctx = await setup()
      const held = createDeferred<string>()
      let attempt = 0
      answer = (call) => {
        if (!call.isBatch) return Promise.resolve(`translated ${call.text}`)
        return ++attempt === 1 ? mismatch() : held.promise
      }
      ctx.request("alpha", "h-alpha", "sA", TAB_A)
      ctx.request("beta", "h-beta", "sA", TAB_A)
      ctx.request("alpha", "h-alpha", "sB", TAB_B)
      const unscoped = ctx.request("alpha", "h-alpha", "sU", UNSCOPED)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      await ctx.cancelSession("sA", TAB_A)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(batchCalls()).toHaveLength(2)

      await ctx.cancelSession("sB", TAB_B)

      expect(batchCalls()[1]!.signal!.aborted).toBe(false)
      held.resolve(`translated alpha\n\n${BATCH_SEPARATOR}\n\ntranslated beta`)
      await vi.advanceTimersByTimeAsync(10)
      expect(unscoped.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })
  })
})
