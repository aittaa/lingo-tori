import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"

/**
 * Ending a subtitle run (OFF, video change) from the content side, through to the provider.
 *
 * Real: the `TranslationCoordinator`, `translateSubtitles` and its per-cue request, the background
 * `enqueueSubtitlesTranslateRequest` handler, the real BatchQueue and the real RequestQueue.
 * Replaced: the message transport (a bus that hands a content message to the handler the
 * background registered, as the extension messaging does), the stored config, and the provider
 * edge (`executeTranslate`, answering with deferred promises so each state can be held open).
 *
 * The assertions are about what reaches the provider and what is shown, never about a message
 * name, so they describe the product the same way before and after the fix.
 */

const bus = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => Promise<unknown>>(),
  sent: [] as Array<{ type: string; data: unknown }>,
  sender: { tab: { id: 1 } },
}))
const getLocalConfigMock = vi.fn<(...args: any[]) => any>()
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const executeTranslateMock = vi.fn<(...args: any[]) => any>()
const resolveGlossaryTermsMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: (type: string, handler: (message: unknown) => Promise<unknown>) => {
    bus.handlers.set(type, handler)
  },
  sendMessage: async (type: string, data: unknown) => {
    bus.sent.push({ type, data: structuredClone(data) })
    const handler = bus.handlers.get(type)
    if (!handler) throw new Error(`No handler registered for '${type}'`)
    return handler({ type, data: structuredClone(data), sender: bus.sender })
  },
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: getLocalConfigMock }))
vi.mock("@/utils/glossary/active-matcher", () => ({
  resolveGlossaryTerms: resolveGlossaryTermsMock,
}))
vi.mock("@/utils/prompts/subtitles", () => ({
  getSubtitlesTranslatePrompt: vi.fn<(...args: any[]) => any>().mockResolvedValue({
    systemPrompt: "system",
    prompt: "prompt",
  }),
  getSubtitlesPromptTemplate: vi.fn<(...args: any[]) => any>().mockResolvedValue({
    systemPrompt: "system",
    prompt: "{{input}}",
  }),
}))
vi.mock("@/entrypoints/background/config", () => ({
  ensureInitializedConfig: ensureInitializedConfigMock,
}))
vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: executeTranslateMock,
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: { get: vi.fn<() => undefined>(), put: vi.fn<() => undefined>() },
    translationCache: {
      delete: vi.fn<() => undefined>(),
      get: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      put: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    },
  },
}))
vi.mock("@/entrypoints/background/background-stream", () => ({
  runStreamTextInBackground: vi.fn<() => undefined>(),
  generateTextForProviderRef: vi.fn<() => undefined>(),
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface ProviderCall {
  text: string
  signal: AbortSignal | undefined
  isBatch: boolean
}

let calls: ProviderCall[]
let answer: (call: ProviderCall) => Promise<string>

const BATCH_JOIN = `\n\n${BATCH_SEPARATOR}\n\n`

const KOREAN: Record<string, string> = { Hello: "안녕하세요", World: "세계" }

/** A correct batch answer: one Korean segment per input segment. */
function koreanAnswer(call: ProviderCall): Promise<string> {
  return Promise.resolve(
    call.text
      .split(BATCH_JOIN)
      .map((item) => KOREAN[item] ?? `번역 ${item}`)
      .join(BATCH_JOIN),
  )
}

function mismatch(): Promise<string> {
  return Promise.resolve("only one segment")
}

const FRAGMENTS: SubtitlesFragment[] = [
  { text: "Hello", start: 0, end: 1_000 },
  { text: "World", start: 1_000, end: 2_000 },
]

const VIDEO_CONTEXT = { videoTitle: "Video", subtitlesTextContent: "Hello World" }

const enqueueMessages = () => bus.sent.filter((m) => m.type === "enqueueSubtitlesTranslateRequest")
const batchCalls = () => calls.filter((call) => call.isBatch)
const individualCalls = () => calls.filter((call) => !call.isBatch)

async function setup() {
  const { setupSubtitlesTranslationHandlers } =
    await import("@/entrypoints/background/subtitles-translation")
  setupSubtitlesTranslationHandlers()
  const { TranslationCoordinator } = await import("../translation-coordinator")

  const onTranslated = vi.fn<(fragments: SubtitlesFragment[]) => void>()
  const onStateChange = vi.fn<(...args: any[]) => any>()
  const video = {
    currentTime: 0.5,
    playbackRate: 1,
    addEventListener: vi.fn<(...args: any[]) => any>(),
    removeEventListener: vi.fn<(...args: any[]) => any>(),
  } as unknown as HTMLVideoElement
  const coordinator = new TranslationCoordinator({
    getFragments: () => FRAGMENTS,
    getVideoElement: () => video,
    getCurrentState: () => "idle",
    segmentationPipeline: null,
    onTranslated,
    onStateChange,
    targetCode: "kor",
  })
  return { coordinator, onTranslated }
}

/** The tick has run far enough to send its requests, but the 100 ms batch delay has not elapsed. */
async function reachQueued() {
  await vi.advanceTimersByTimeAsync(10)
}

async function reachInFlight() {
  await vi.advanceTimersByTimeAsync(200)
}

describe("ending a subtitle run reaches the provider", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    fakeBrowser.reset()
    bus.handlers.clear()
    bus.sent.length = 0
    calls = []
    answer = koreanAnswer
    getLocalConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
      videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId: "openai-default" },
    })
    ensureInitializedConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        requestQueueConfig: { rate: 100, capacity: 100 },
        batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
      },
    })
    resolveGlossaryTermsMock.mockResolvedValue({ terms: [], revision: 0 })
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
    it("translates the cues and hands the Korean translations to the display", async () => {
      const { coordinator, onTranslated } = await setup()

      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()

      expect(onTranslated).toHaveBeenCalledTimes(1)
      expect(onTranslated.mock.calls[0]![0]).toEqual([
        { text: "Hello", start: 0, end: 1_000, translation: "안녕하세요" },
        { text: "World", start: 1_000, end: 2_000, translation: "세계" },
      ])
      coordinator.stop()
    })

    it("drops a result that arrives after the run ended (the runId guard)", async () => {
      const held = createDeferred<string>()
      answer = () => held.promise
      const { coordinator, onTranslated } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      expect(calls).toHaveLength(1)

      coordinator.stop()
      held.resolve(`안녕하세요${BATCH_JOIN}세계`)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(onTranslated).not.toHaveBeenCalled()
    })

    it("does not start a second tick after the run ended", async () => {
      const held = createDeferred<string>()
      answer = () => held.promise
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()

      coordinator.stop()
      held.resolve(`안녕하세요${BATCH_JOIN}세계`)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(1)
    })

    it("a coordinator that never started sends no cancel", async () => {
      const { coordinator } = await setup()

      coordinator.stop()
      coordinator.reset()
      await vi.advanceTimersByTimeAsync(10)

      expect(bus.sent).toHaveLength(0)
    })
  })

  describe("OFF", () => {
    it("queued in the BatchQueue: the request never reaches the provider", async () => {
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachQueued()
      expect(enqueueMessages().length).toBeGreaterThan(0)
      expect(calls).toHaveLength(0)

      coordinator.stop()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(calls).toHaveLength(0)
    })

    it("in flight: the provider request is aborted", async () => {
      const held = createDeferred<string>()
      answer = () => held.promise
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.signal!.aborted).toBe(false)

      coordinator.stop()
      await vi.advanceTimersByTimeAsync(0)

      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("in a mismatch backoff: no further attempt and no individual fallback", async () => {
      answer = mismatch
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      expect(batchCalls()).toHaveLength(1)

      coordinator.stop()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(batchCalls()).toHaveLength(1)
      expect(individualCalls()).toHaveLength(0)
    })

    it("in the individual fallback: the held requests are aborted", async () => {
      const held = createDeferred<string>()
      answer = (call) => (call.isBatch ? mismatch() : held.promise)
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      await vi.advanceTimersByTimeAsync(7_000)
      expect(batchCalls()).toHaveLength(4)
      expect(individualCalls()).toHaveLength(2)

      coordinator.stop()
      await vi.advanceTimersByTimeAsync(0)

      for (const call of individualCalls()) expect(call.signal!.aborted).toBe(true)
    })

    it("while a cue is still being prepared: no request is sent after the OFF", async () => {
      const glossary = createDeferred<{ terms: never[]; revision: number }>()
      resolveGlossaryTermsMock.mockReturnValue(glossary.promise)
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await vi.advanceTimersByTimeAsync(10)
      expect(enqueueMessages()).toHaveLength(0)

      coordinator.stop()
      glossary.resolve({ terms: [], revision: 0 })
      await vi.advanceTimersByTimeAsync(60_000)

      expect(enqueueMessages()).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })

    it("stopping twice ends the run once", async () => {
      const held = createDeferred<string>()
      answer = () => held.promise
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()

      coordinator.stop()
      coordinator.stop()
      await vi.advanceTimersByTimeAsync(10)

      const cancels = bus.sent.filter((m) => m.type !== "enqueueSubtitlesTranslateRequest")
      expect(cancels).toHaveLength(1)
    })
  })

  describe("video change and reset", () => {
    it("reset aborts what is in flight", async () => {
      const held = createDeferred<string>()
      answer = () => held.promise
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      expect(calls[0]!.signal!.aborted).toBe(false)

      coordinator.reset()
      await vi.advanceTimersByTimeAsync(0)

      expect(calls[0]!.signal!.aborted).toBe(true)
    })

    it("reset during a backoff: no further attempt", async () => {
      answer = mismatch
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()

      coordinator.reset()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(batchCalls()).toHaveLength(1)
      expect(individualCalls()).toHaveLength(0)
    })
  })

  describe("OFF, then ON again", () => {
    it("the new run is answered and shown (the old run does not take it away)", async () => {
      const { coordinator, onTranslated } = await setup()
      const first = createDeferred<string>()
      answer = () => first.promise
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()

      coordinator.stop()
      answer = koreanAnswer
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      // A slow provider finishing the old run's request must not matter to the new run.
      first.resolve(`안녕하세요${BATCH_JOIN}세계`)
      await vi.advanceTimersByTimeAsync(200)

      expect(onTranslated).toHaveBeenCalledTimes(1)
      expect(onTranslated.mock.calls[0]![0]).toEqual([
        { text: "Hello", start: 0, end: 1_000, translation: "안녕하세요" },
        { text: "World", start: 1_000, end: 2_000, translation: "세계" },
      ])
      coordinator.stop()
    })

    it("the run that ended is aborted and the new run is a different owner", async () => {
      const { coordinator } = await setup()
      const first = createDeferred<string>()
      answer = () => first.promise
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      const firstSignal = calls[0]!.signal!

      coordinator.stop()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      await vi.advanceTimersByTimeAsync(0)

      expect(firstSignal.aborted).toBe(true)
      const owners = new Set(
        enqueueMessages().map((m) => (m.data as { ownerId?: string }).ownerId ?? null),
      )
      expect(owners.size).toBe(2)
      expect(owners.has(null)).toBe(false)
    })

    it("starting a run that is already running keeps its owner", async () => {
      const held = createDeferred<string>()
      answer = () => held.promise
      const { coordinator } = await setup()
      coordinator.start(VIDEO_CONTEXT)
      await reachInFlight()
      const firstSignal = calls[0]!.signal!

      coordinator.start()
      await vi.advanceTimersByTimeAsync(10)

      expect(firstSignal.aborted).toBe(false)
    })
  })
})
