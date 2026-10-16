import type { LLMProviderConfig, TranslateProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

/**
 * Who owns a subtitle request in the background.
 *
 * Drives the real `enqueueSubtitlesTranslateRequest` handler, the real BatchQueue and the real
 * RequestQueue, wired exactly as in production. Only the provider edge (`executeTranslate`), the
 * config and cache storage and the message registry are replaced.
 *
 * An owner is one run of the subtitle coordinator, carried as `ownerId`. Ending the run (OFF,
 * video change) sends the cancel message for it; closing the tab sweeps every owner of that tab.
 * The queues keep their existing contract: an item shared by several owners is only aborted when
 * the last one has left, and a request with no owner (the exporter, an older content script) pins
 * the item.
 *
 * Tabs: 1 and 2 are normal tabs, 3 is a private-window tab, NO_TAB has no tab at all.
 */

const messageHandlers = vi.hoisted(() => new Map<string, (message: unknown) => Promise<unknown>>())
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const executeTranslateMock = vi.fn<(...args: any[]) => any>()
const putBatchRequestRecordMock = vi.fn<(...args: any[]) => any>()
const translationCacheGetMock = vi.fn<(...args: any[]) => any>()
const translationCachePutMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: (type: string, handler: (message: unknown) => Promise<unknown>) => {
    messageHandlers.set(type, handler)
  },
}))
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
// A pure translate provider has no batch queue: its requests go straight to the RequestQueue.
const translateProvider = {
  ...DEFAULT_PROVIDER_CONFIG.deepl,
  apiKey: "deepl-key",
} as TranslateProviderConfig

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

function correctAnswer(call: ProviderCall): Promise<string> {
  const items = call.text.split(`\n\n${BATCH_SEPARATOR}\n\n`)
  return Promise.resolve(
    items.map((item) => `translated ${item}`).join(`\n\n${BATCH_SEPARATOR}\n\n`),
  )
}

function configureQueues(requestQueueConfig: { rate: number; capacity: number }) {
  ensureInitializedConfigMock.mockResolvedValue({
    ...DEFAULT_CONFIG,
    videoSubtitles: {
      ...DEFAULT_CONFIG.videoSubtitles,
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

function expectCancelled(result: { outcome: () => Outcome | undefined }) {
  const outcome = result.outcome()
  expect(outcome?.ok).toBe(false)
  expect(isTranslationCancelledError((outcome as { error: unknown }).error)).toBe(true)
}

async function setup() {
  const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
  setupSubtitlesTranslationHandlers()
  const enqueue = getHandler("enqueueSubtitlesTranslateRequest")

  /** `ownerId` undefined sends no owner at all, like the exporter or an older content script. */
  const request = (
    text: string,
    hash: string,
    ownerId: string | undefined,
    sender: Sender,
    options: {
      provider?: LLMProviderConfig | TranslateProviderConfig
      promptTemplate?: unknown
    } = {},
  ) =>
    settle(
      enqueue({
        data: {
          text,
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local", config: options.provider ?? llmProvider },
          scheduleAt: Date.now(),
          hash,
          ...(ownerId === undefined ? {} : { ownerId }),
          ...(options.promptTemplate === undefined
            ? {}
            : { promptTemplate: options.promptTemplate }),
        },
        sender,
      }),
    )

  /**
   * Ending a run. Before the subtitle cancel message exists there is nothing to send, so the helper
   * sends nothing and the assertions after it report what the product does.
   */
  const cancelOwner = async (ownerId: string, sender: Sender) => {
    const cancel = messageHandlers.get("cancelSubtitlesTranslateRequests")
    if (cancel) await cancel({ data: { ownerId }, sender })
    await vi.advanceTimersByTimeAsync(0)
  }

  const closeTab = async (tabId: number) => {
    await fakeBrowser.tabs.onRemoved.trigger(tabId, { windowId: 1, isWindowClosing: false })
    await vi.advanceTimersByTimeAsync(0)
  }

  return { request, cancelOwner, closeTab }
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

describe("subtitle request ownership in the background", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    fakeBrowser.reset()
    messageHandlers.clear()
    calls = []
    answer = correctAnswer
    configureQueues({ rate: 100, capacity: 100 })
    putBatchRequestRecordMock.mockResolvedValue(undefined)
    translationCacheGetMock.mockResolvedValue(undefined)
    translationCachePutMock.mockResolvedValue(undefined)
    executeTranslateMock.mockImplementation(
      (text: string, _lang: unknown, _provider: unknown, _prompt: unknown, options?: any) => {
        const call: ProviderCall = {
          text,
          signal: options?.signal,
          isBatch: options?.isBatch === true,
        }
        calls.push(call)
        return answer(call)
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("positive controls: what must not change", () => {
    it("translates a cue and stores the result under its hash (normal subtitle translation)", async () => {
      const { request } = await setup()
      const cue = request("hello", "h-hello", "run-a", TAB_1, {
        promptTemplate: { systemPrompt: "s", prompt: "p" },
      })

      await flush()

      expect(cue.outcome()).toEqual({ ok: true, value: "translated hello" })
      expect(translationCachePutMock).toHaveBeenCalledTimes(1)
      expect(translationCachePutMock.mock.calls[0]![0]).toMatchObject({
        key: "h-hello",
        translation: "translated hello",
      })
    })

    it("answers from the cache without any provider call", async () => {
      translationCacheGetMock.mockResolvedValue({ translation: "cached hello" })
      const { request } = await setup()

      const cue = request("hello", "h-hello", "run-a", TAB_1)
      await flush()

      expect(cue.outcome()).toEqual({ ok: true, value: "cached hello" })
      expect(calls).toHaveLength(0)
    })

    it("a run that ended does not take its successor's identical cue away", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1)
      await flush()
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      const second = request("hello", "h-hello", "run-b", TAB_1)
      held.resolve("translated hello")
      await flush()

      // The first call is cancelled or completed; either way the new run is answered.
      await vi.advanceTimersByTimeAsync(10)
      expect(second.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("an unowned request (the exporter, an older content script) pins a shared item", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const owned = request("hello", "h-hello", "run-a", TAB_1)
      const unowned = request("hello", "h-hello", undefined, TAB_1)
      await flush()
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(unowned.outcome()).toEqual({ ok: true, value: "translated hello" })
      expect(owned.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("an unowned request that joins after the owner pins the item too", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(10)
      const unowned = request("hello", "h-hello", undefined, TAB_1)
      await flush()

      await cancelOwner("run-a", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(unowned.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("an export request in the tab of a run that ended is not touched", async () => {
      const { request, cancelOwner } = await setup()
      await cancelOwner("run-a", TAB_1)

      const exported = request("hello", "h-hello", undefined, TAB_1)
      await flush()

      expect(calls).toHaveLength(1)
      expect(exported.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("in a private-window tab an unowned request pins its item like anywhere else", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const owned = request("hello", "h-hello", "run-p", TAB_3_PRIVATE)
      const exported = request("hello", "h-hello", undefined, TAB_3_PRIVATE)
      await flush()
      expect(calls).toHaveLength(1)

      await cancelOwner("run-p", TAB_3_PRIVATE)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(owned.outcome()).toEqual({ ok: true, value: "translated hello" })
      expect(exported.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("an unowned request does not share an item with a private-window tab's", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-p", TAB_3_PRIVATE)
      const exported = request("hello", "h-hello", undefined, TAB_1)
      await flush()
      expect(calls).toHaveLength(2)

      // The private tab's run ends: only its own provider request goes, the export's stays.
      await cancelOwner("run-p", TAB_3_PRIVATE)

      expect(calls.filter((call) => call.signal!.aborted)).toHaveLength(1)
      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(exported.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("an owner on a sender with no tab cannot be cancelled (it is unowned)", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const cue = request("hello", "h-hello", "run-a", NO_TAB)
      await flush()

      await cancelOwner("run-a", NO_TAB)

      expect(calls[0]!.signal!.aborted).toBe(false)
      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(cue.outcome()).toEqual({ ok: true, value: "translated hello" })
    })
  })

  describe("a run ends (OFF, video change): the item is aborted and nothing new starts", () => {
    it("queued in the BatchQueue: the request never reaches the provider", async () => {
      const { request, cancelOwner } = await setup()
      const cue = request("hello", "h-hello", "run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(0)

      await cancelOwner("run-a", TAB_1)
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expectCancelled(cue)
    })

    it("held by the dispatch gate behind a busy RequestQueue: it is dropped and never sent", async () => {
      configureQueues({ rate: 1, capacity: 1 })
      const { request, cancelOwner } = await setup()
      const busy = createDeferred<string>()
      answer = () => busy.promise
      request("busy", "h-busy", "run-busy", TAB_2)
      await flush()
      expect(calls).toHaveLength(1)

      const waiting = request("waiting", "h-waiting", "run-a", TAB_1)
      await flush()
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      busy.resolve("translated busy")
      await vi.advanceTimersByTimeAsync(10_000)

      expect(calls.filter((call) => call.text === "waiting")).toHaveLength(0)
      expectCancelled(waiting)
    })

    it("in flight: the provider request is aborted and the cue fails as cancelled", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const cue = request("hello", "h-hello", "run-a", TAB_1)
      await flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await cancelOwner("run-a", TAB_1)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expectCancelled(cue)
    })

    it("in flight, a provider that ignores the abort cannot revive it: no retry starts", async () => {
      const { request, cancelOwner } = await setup()
      answer = (call) =>
        new Promise((_, reject) =>
          call.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        )
      const cue = request("hello", "h-hello", "run-a", TAB_1)
      await flush()

      await cancelOwner("run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(1)
      expectCancelled(cue)
    })

    it("in a mismatch backoff: no further attempt and no individual fallback", async () => {
      const { request, cancelOwner } = await setup()
      answer = mismatch
      const alpha = request("alpha", "h-alpha", "run-a", TAB_1)
      const beta = request("beta", "h-beta", "run-a", TAB_1)
      await flush()
      expect(batchCalls()).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(batchCalls()).toHaveLength(1)
      expect(individualCalls("alpha")).toHaveLength(0)
      expect(individualCalls("beta")).toHaveLength(0)
      expectCancelled(alpha)
      expectCancelled(beta)
    })

    it("in the last backoff before the fallback: the individual requests are never sent", async () => {
      const { request, cancelOwner } = await setup()
      answer = mismatch
      const alpha = request("alpha", "h-alpha", "run-a", TAB_1)
      request("beta", "h-beta", "run-a", TAB_1)
      await flush()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(batchCalls()).toHaveLength(3)

      await cancelOwner("run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(batchCalls()).toHaveLength(3)
      expect(calls.filter((call) => !call.isBatch)).toHaveLength(0)
      expectCancelled(alpha)
    })

    it("in the individual fallback: every held request is aborted", async () => {
      const { request, cancelOwner } = await setup()
      const heldAlpha = createDeferred<string>()
      const heldBeta = createDeferred<string>()
      answer = (call) => {
        if (call.isBatch) return mismatch()
        return call.text === "alpha" ? heldAlpha.promise : heldBeta.promise
      }
      const alpha = request("alpha", "h-alpha", "run-a", TAB_1)
      const beta = request("beta", "h-beta", "run-a", TAB_1)
      await flush()
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)
      expect(batchCalls()).toHaveLength(4)
      expect(individualCalls("alpha")).toHaveLength(1)
      expect(individualCalls("beta")).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)

      expect(individualCalls("alpha")[0]!.signal!.aborted).toBe(true)
      expect(individualCalls("beta")[0]!.signal!.aborted).toBe(true)
      expectCancelled(alpha)
      expectCancelled(beta)
    })

    it("a pure translate provider, waiting in the RequestQueue: it is never dispatched", async () => {
      configureQueues({ rate: 1, capacity: 1 })
      const { request, cancelOwner } = await setup()
      const busy = createDeferred<string>()
      answer = () => busy.promise
      request("busy", "h-busy", "run-busy", TAB_2, { provider: translateProvider })
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      const waiting = request("waiting", "h-waiting", "run-a", TAB_1, {
        provider: translateProvider,
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      busy.resolve("translated busy")
      await vi.advanceTimersByTimeAsync(10_000)

      expect(calls.filter((call) => call.text === "waiting")).toHaveLength(0)
      expectCancelled(waiting)
    })

    it("a pure translate provider, in flight: the provider request is aborted", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const cue = request("hello", "h-hello", "run-a", TAB_1, { provider: translateProvider })
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expectCancelled(cue)
    })

    it("suspended on the cache lookup when the run ends: it does not enqueue afterwards", async () => {
      const lookup = createDeferred<undefined>()
      translationCacheGetMock.mockReturnValue(lookup.promise)
      const { request, cancelOwner } = await setup()
      const cue = request("hello", "h-hello", "run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(10)

      await cancelOwner("run-a", TAB_1)
      lookup.resolve(undefined)
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expectCancelled(cue)
    })

    it("the cancel arrives while the enqueue still waits for the queue configuration (a cold worker)", async () => {
      const configuration = createDeferred<unknown>()
      ensureInitializedConfigMock.mockReturnValue(configuration.promise)
      const { request } = await setup()
      const cue = request("hello", "h-hello", "run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(10)

      // Sent without waiting for it: the cancel handler itself waits for the queues too.
      const cancel = messageHandlers.get("cancelSubtitlesTranslateRequests")
      const cancelling = cancel?.({ data: { ownerId: "run-a" }, sender: TAB_1 })
      await vi.advanceTimersByTimeAsync(10)
      configuration.resolve({
        ...DEFAULT_CONFIG,
        videoSubtitles: {
          ...DEFAULT_CONFIG.videoSubtitles,
          requestQueueConfig: { rate: 100, capacity: 100 },
          batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
        },
      })
      await cancelling
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expectCancelled(cue)
    })

    it("a request of an ended run that arrives late is refused", async () => {
      const { request, cancelOwner } = await setup()
      await cancelOwner("run-a", TAB_1)

      const late = request("hello", "h-hello", "run-a", TAB_1)
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expectCancelled(late)
    })
  })

  describe("the tab closes", () => {
    it("a request that arrives after its tab closed is refused", async () => {
      const { request, closeTab } = await setup()
      await closeTab(7)

      const late = request("hello", "h-hello", "run-a", { tab: { id: 7 } })
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expectCancelled(late)
    })

    it("in flight: the provider request is aborted", async () => {
      const { request, closeTab } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const cue = request("hello", "h-hello", "run-a", { tab: { id: 7 } })
      await flush()
      expect(calls).toHaveLength(1)

      await closeTab(7)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expectCancelled(cue)
    })

    it("queued: nothing is sent", async () => {
      const { request, closeTab } = await setup()
      const cue = request("hello", "h-hello", "run-a", { tab: { id: 7 } })
      await vi.advanceTimersByTimeAsync(10)

      await closeTab(7)
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
      expectCancelled(cue)
    })

    it("in a mismatch backoff: no further attempt", async () => {
      const { request, closeTab } = await setup()
      answer = mismatch
      request("alpha", "h-alpha", "run-a", { tab: { id: 7 } })
      request("beta", "h-beta", "run-a", { tab: { id: 7 } })
      await flush()
      expect(batchCalls()).toHaveLength(1)

      await closeTab(7)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(batchCalls()).toHaveLength(1)
      expect(calls.filter((call) => !call.isBatch)).toHaveLength(0)
    })

    it("a different tab's identical item is not taken away", async () => {
      const { request, closeTab } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", { tab: { id: 7 } })
      const other = request("hello", "h-hello", "run-b", TAB_2)
      await flush()
      expect(calls).toHaveLength(1)

      await closeTab(7)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(other.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("a tab with the same digits as a prefix is not swept (tab 1 does not close tab 12)", async () => {
      const { request, closeTab } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const cue = request("hello", "h-hello", "run-a", { tab: { id: 12 } })
      await flush()

      await closeTab(1)

      expect(calls[0]!.signal!.aborted).toBe(false)
      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(cue.outcome()).toEqual({ ok: true, value: "translated hello" })
    })
  })

  describe("an item shared by several owners keeps running until the last one leaves", () => {
    it("preservation control, direct path: the first leaving does not stop the second from being answered", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1, { provider: translateProvider })
      const b = request("hello", "h-hello", "run-b", TAB_2, { provider: translateProvider })
      await vi.advanceTimersByTimeAsync(10)
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(b.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("direct path: the last owner leaving aborts the item", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1, { provider: translateProvider })
      request("hello", "h-hello", "run-b", TAB_2, { provider: translateProvider })
      await vi.advanceTimersByTimeAsync(10)

      await cancelOwner("run-a", TAB_1)
      await cancelOwner("run-b", TAB_2)

      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("two tabs asking for the same cue: the first leaving detaches, the last leaving aborts", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const a = request("hello", "h-hello", "run-a", TAB_1)
      const b = request("hello", "h-hello", "run-b", TAB_2)
      await flush()
      expect(calls).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await cancelOwner("run-b", TAB_2)
      expect(calls[0]!.signal!.aborted).toBe(true)
      expectCancelled(a)
      expectCancelled(b)
    })

    it("preservation control: the first leaving does not stop the second from being answered", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1)
      const b = request("hello", "h-hello", "run-b", TAB_2)
      await flush()

      await cancelOwner("run-a", TAB_1)
      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)

      expect(b.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    it("the order does not matter: the second leaving first leaves the item to the first", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1)
      request("hello", "h-hello", "run-b", TAB_2)
      await flush()

      await cancelOwner("run-b", TAB_2)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await cancelOwner("run-a", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("two runs of one tab asking for the same cue are two owners", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      request("hello", "h-hello", "run-a", TAB_1)
      request("hello", "h-hello", "run-b", TAB_1)
      await flush()

      await cancelOwner("run-a", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      await cancelOwner("run-b", TAB_1)
      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("a private-window tab never shares an item with a normal tab", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      const normal = request("hello", "h-hello", "run-a", TAB_1)
      const privateTab = request("hello", "h-hello", "run-p", TAB_3_PRIVATE)
      await flush()
      expect(calls).toHaveLength(2)

      await cancelOwner("run-a", TAB_1)

      // Exactly one of the two provider requests is the normal tab's, and it is the one aborted.
      expect(calls.filter((call) => call.signal!.aborted)).toHaveLength(1)
      expectCancelled(normal)
      expect(privateTab.outcome()).toBeUndefined()
      held.resolve("translated hello")
      await vi.advanceTimersByTimeAsync(10)
      expect(privateTab.outcome()).toEqual({ ok: true, value: "translated hello" })
    })

    /**
     * Run A asks for alpha and beta, run B (another tab) for alpha, all before the flush. Every
     * batch attempt comes back one segment short, so after the backoffs each is sent alone; alpha
     * has two owners, beta one.
     */
    async function reachHeldFallback() {
      const ctx = await setup()
      const heldAlpha = createDeferred<string>()
      const heldBeta = createDeferred<string>()
      answer = (call) => {
        if (call.isBatch) return mismatch()
        return call.text === "alpha" ? heldAlpha.promise : heldBeta.promise
      }
      const alphaA = ctx.request("alpha", "h-alpha", "run-a", TAB_1)
      const betaA = ctx.request("beta", "h-beta", "run-a", TAB_1)
      const alphaB = ctx.request("alpha", "h-alpha", "run-b", TAB_2)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      await vi.advanceTimersByTimeAsync(ALL_RETRY_BACKOFFS_MS)
      expect(batchCalls()).toHaveLength(4)
      return { ...ctx, heldAlpha, alphaA, betaA, alphaB }
    }

    it("fallback: the leaving owner takes its own item away and leaves the shared one running", async () => {
      const { cancelOwner, heldAlpha, alphaB, betaA } = await reachHeldFallback()

      await cancelOwner("run-a", TAB_1)

      expect(individualCalls("beta")[0]!.signal!.aborted).toBe(true)
      expect(individualCalls("alpha")[0]!.signal!.aborted).toBe(false)
      expectCancelled(betaA)
      heldAlpha.resolve("translated alpha")
      await vi.advanceTimersByTimeAsync(10)
      expect(alphaB.outcome()).toEqual({ ok: true, value: "translated alpha" })
    })

    it("fallback: the last owner leaving aborts the shared item too", async () => {
      const { cancelOwner } = await reachHeldFallback()

      await cancelOwner("run-a", TAB_1)
      await cancelOwner("run-b", TAB_2)

      expect(individualCalls("alpha")[0]!.signal!.aborted).toBe(true)
    })

    it("backoff: an owner that left during the sleep is not an owner of the retry", async () => {
      const { request, cancelOwner } = await setup()
      const held = createDeferred<string>()
      let attempt = 0
      answer = (call) => {
        if (!call.isBatch) return Promise.resolve(`translated ${call.text}`)
        return ++attempt === 1 ? mismatch() : held.promise
      }
      request("alpha", "h-alpha", "run-a", TAB_1)
      request("beta", "h-beta", "run-a", TAB_1)
      const alphaB = request("alpha", "h-alpha", "run-b", TAB_2)
      await vi.advanceTimersByTimeAsync(10)
      await flush()
      expect(batchCalls()).toHaveLength(1)

      await cancelOwner("run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(batchCalls()).toHaveLength(2)
      expect(batchCalls()[1]!.signal!.aborted).toBe(false)

      // The retry belongs to run B alone now, so B leaving is the last owner leaving.
      await cancelOwner("run-b", TAB_2)

      expect(batchCalls()[1]!.signal!.aborted).toBe(true)
      expectCancelled(alphaB)
    })
  })

  /**
   * The registry that refuses a late request is bounded: it forgets a scope after ten minutes, and
   * keeps at most 256. A request for a scope it has forgotten is not refused; it is enqueued under
   * its scope, so it is still owned by its tab and closing the tab still ends it. Reaching this
   * needs a message that spent more than that in transit, which a run that has ended cannot send
   * (the content side checks the run is current in the same turn as the send) and which the
   * extension messaging does not hold back for.
   */
  describe("a scope the registry has forgotten", () => {
    it("is remembered for ten minutes: a late request inside that time is refused", async () => {
      const { request, cancelOwner } = await setup()
      await cancelOwner("run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      await cancelOwner("run-other", TAB_2)

      const late = request("hello", "h-hello", "run-a", TAB_1)
      await flush()

      expect(calls).toHaveLength(0)
      expectCancelled(late)
    })

    it("after ten minutes a late request is not refused, but it stays owned by its tab", async () => {
      const { request, cancelOwner, closeTab } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      await cancelOwner("run-a", TAB_1)
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000)
      // The registry prunes when a scope is added.
      await cancelOwner("run-other", TAB_2)

      const late = request("hello", "h-hello", "run-a", TAB_1)
      await flush()
      expect(calls).toHaveLength(1)

      await closeTab(1)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expectCancelled(late)
    })

    it("beyond 256 newer scopes a late request is not refused, but it stays owned by its tab", async () => {
      const { request, cancelOwner, closeTab } = await setup()
      const held = createDeferred<string>()
      answer = () => held.promise
      await cancelOwner("run-a", TAB_1)
      for (let index = 0; index < 256; index++) await cancelOwner(`run-newer-${index}`, TAB_2)

      const late = request("hello", "h-hello", "run-a", TAB_1)
      await flush()
      expect(calls).toHaveLength(1)

      await closeTab(1)

      expect(calls[0]!.signal!.aborted).toBe(true)
      expectCancelled(late)
    })
  })
})
