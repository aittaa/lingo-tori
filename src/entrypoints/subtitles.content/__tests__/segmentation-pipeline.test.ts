import type { ChunkSegmentedHandler } from "../segmentation-pipeline"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PROCESS_LOOK_AHEAD_MS } from "@/utils/constants/subtitles"
import { aiSegmentBlock } from "@/utils/subtitles/processor/ai-segmentation"
import { SegmentationPipeline } from "../segmentation-pipeline"

vi.mock("@/utils/subtitles/processor/ai-segmentation", () => ({
  aiSegmentBlock: vi.fn<(...args: any[]) => any>().mockRejectedValue(new Error("ai failed")),
}))

const LOCAL_REF = { kind: "local" as const, config: { id: "openai-default" } as never }

// The raw cues of one window, and a baseline that is deliberately NOT what segmenting them yields:
// a stale cue over the window, and a cue far past it that this pass must leave alone.
const rawCues = (): SubtitlesFragment[] => [
  { text: "hello", start: 0, end: 500 },
  { text: "world", start: 500, end: 1000 },
]
const STALE_CUE: SubtitlesFragment = { text: "obsolete baseline", start: 0, end: 1000 }
const OUTSIDE_CUE: SubtitlesFragment = { text: "cue past the window", start: 120_000, end: 121_000 }
const baselineCues = (): SubtitlesFragment[] => [{ ...STALE_CUE }, { ...OUTSIDE_CUE }]
// What the local fallback makes of `rawCues()` (the rule-based optimizer joins the two words).
const FALLBACK_CUE: SubtitlesFragment = { text: "hello world", start: 0, end: 1000 }
// What a successful AI segmentation of `rawCues()` returns in the restart cases.
const AI_CUE: SubtitlesFragment = { text: "segmented by the second run", start: 0, end: 1000 }
const LATE_CUE: SubtitlesFragment = { text: "late result after stop", start: 0, end: 1000 }

function createPipeline(options: {
  providerRef: PromptableProviderRef | null
  onChunkSegmented: ChunkSegmentedHandler
}) {
  return new SegmentationPipeline({
    baselineFragments: baselineCues(),
    rawFragments: rawCues(),
    getVideoElement: () => ({ currentTime: 0 }) as HTMLVideoElement,
    getSourceLanguage: () => "en",
    providerRef: options.providerRef,
    onChunkSegmented: options.onChunkSegmented,
  })
}

/** Lets the loop of a started pipeline finish: it is only visible through `isRunning`. */
async function settle(pipeline: SegmentationPipeline) {
  for (let i = 0; i < 100 && pipeline.isRunning; i++) await Promise.resolve()
  expect(pipeline.isRunning, "the segmentation loop did not finish").toBe(false)
}

/** Waits (by microtasks) until the AI segmentation has been called `count` times in this test. */
async function untilAiCalls(count: number, before: number) {
  for (let i = 0; i < 100 && vi.mocked(aiSegmentBlock).mock.calls.length - before < count; i++) {
    await Promise.resolve()
  }
  expect(vi.mocked(aiSegmentBlock).mock.calls.length - before).toBe(count)
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  // Back to the default every other test relies on: AI segmentation fails.
  vi.mocked(aiSegmentBlock).mockReset()
  vi.mocked(aiSegmentBlock).mockRejectedValue(new Error("ai failed"))
})

describe("segmentation pipeline", () => {
  it("does not segment past the look-ahead window from the current position", async () => {
    // 10 minutes of word-level fragments, one per second.
    const rawFragments = Array.from({ length: 600 }, (_, i) => ({
      text: `w${i}`,
      start: i * 1000,
      end: i * 1000 + 1000,
    }))

    const pipeline = new SegmentationPipeline({
      rawFragments,
      // Playback stays at the very beginning (e.g. paused right after enabling).
      getVideoElement: () => ({ currentTime: 0 }) as HTMLVideoElement,
      getSourceLanguage: () => "en",
      providerRef: LOCAL_REF,
      preSegmented: true,
    })

    await (pipeline as any).runLoop()

    const segmentedStarts = (pipeline as any).segmentedRawStarts as Set<number>

    // The window ahead of the playhead is segmented...
    expect(segmentedStarts.has(0)).toBe(true)

    // ...and nothing beyond it. Chunks are kept a whole PROCESS_LOOK_AHEAD_MS wide and are
    // only started while their first fragment is within the look-ahead window, so the buffer
    // reaches at most two windows ahead of the playhead — not the rest of the video.
    const furthestSegmented = Math.max(...segmentedStarts)
    expect(furthestSegmented).toBeLessThan(2 * PROCESS_LOOK_AHEAD_MS)
    expect(pipeline.hasUnprocessedChunks()).toBe(true)
  })

  it("widens the segmentation look-ahead window with playback rate", async () => {
    // 10 minutes of word-level fragments, one per second.
    const rawFragments = Array.from({ length: 600 }, (_, i) => ({
      text: `w${i}`,
      start: i * 1000,
      end: i * 1000 + 1000,
    }))

    const pipeline = new SegmentationPipeline({
      rawFragments,
      getVideoElement: () => ({ currentTime: 0, playbackRate: 3 }) as HTMLVideoElement,
      getSourceLanguage: () => "en",
      providerRef: LOCAL_REF,
      preSegmented: true,
    })

    await (pipeline as any).runLoop()

    const segmentedStarts = (pipeline as any).segmentedRawStarts as Set<number>
    const furthestSegmented = Math.max(...segmentedStarts)

    // At 3x the window is 3x wider, so the buffer reaches past the 1x bound...
    expect(furthestSegmented).toBeGreaterThan(2 * PROCESS_LOOK_AHEAD_MS)
    // ...but still stays within two 3x-wide windows, not the rest of the video.
    expect(furthestSegmented).toBeLessThan(2 * 3 * PROCESS_LOOK_AHEAD_MS)
    expect(pipeline.hasUnprocessedChunks()).toBe(true)
  })

  it("segments the next window once playback advances into it", async () => {
    const rawFragments = Array.from({ length: 600 }, (_, i) => ({
      text: `w${i}`,
      start: i * 1000,
      end: i * 1000 + 1000,
    }))

    let currentTime = 0
    const pipeline = new SegmentationPipeline({
      rawFragments,
      getVideoElement: () =>
        ({
          get currentTime() {
            return currentTime
          },
        }) as HTMLVideoElement,
      getSourceLanguage: () => "en",
      providerRef: LOCAL_REF,
      preSegmented: true,
    })

    await (pipeline as any).runLoop()
    const afterStart = Math.max(...((pipeline as any).segmentedRawStarts as Set<number>))

    // Playback moves into the buffered region; the pipeline should top the window back up
    // rather than stay starved behind its own bound.
    currentTime = 150
    await (pipeline as any).runLoop()
    const afterAdvance = Math.max(...((pipeline as any).segmentedRawStarts as Set<number>))

    expect(afterAdvance).toBeGreaterThan(afterStart)
    expect(afterAdvance).toBeLessThan(150_000 + 2 * PROCESS_LOOK_AHEAD_MS)
  })

  // Both fallbacks must do what the translation pipeline relies on: install the optimized cues in
  // `processedFragments` (it reads them from there, not from the callback) AND tell the adapter.
  // The baseline is not what the fallback yields, so neither can pass by leaving the state as it was.
  it.each([
    {
      name: "AI segmentation fails",
      providerRef: LOCAL_REF as PromptableProviderRef | null,
      aiCalls: 1,
      failureRemembered: true,
    },
    {
      name: "no provider is configured",
      providerRef: null as PromptableProviderRef | null,
      aiCalls: 0,
      failureRemembered: false,
    },
  ])(
    "falls back to local optimization when $name: state and callback both carry the result",
    async ({ providerRef, aiCalls, failureRemembered }) => {
      const onChunkSegmented = vi.fn<ChunkSegmentedHandler>()
      const aiCallsBefore = vi.mocked(aiSegmentBlock).mock.calls.length
      const pipeline = createPipeline({ providerRef, onChunkSegmented })
      expect(pipeline.processedFragments).toEqual([STALE_CUE, OUTSIDE_CUE])

      pipeline.start()
      await settle(pipeline)

      // State: the stale cue over the window is gone, the result is in, the cue past it is untouched.
      expect(
        pipeline.processedFragments,
        "the fallback result must be installed in processedFragments, not only reported",
      ).toEqual([FALLBACK_CUE, OUTSIDE_CUE])
      // Callback: once, with the raw chunk and exactly the cues that were installed.
      expect(onChunkSegmented).toHaveBeenCalledTimes(1)
      expect(onChunkSegmented).toHaveBeenCalledWith(rawCues(), [FALLBACK_CUE])
      // The branch taken: AI is asked once when it is configured, never when it is not.
      expect(vi.mocked(aiSegmentBlock).mock.calls.length - aiCallsBefore).toBe(aiCalls)
      // The chunk is not orphaned: it counts as segmented now, and only an AI failure is retried.
      expect(pipeline.hasUnprocessedChunks()).toBe(false)
      pipeline.clearFailedStarts()
      expect(pipeline.hasUnprocessedChunks()).toBe(failureRemembered)
    },
  )

  it("replaceProcessedChunk drops cues that overlap the window by interval", () => {
    const pipeline = new SegmentationPipeline({
      baselineFragments: [
        { text: "spans into window", start: 0, end: 1500 },
        { text: "after", start: 2000, end: 3000 },
      ],
      rawFragments: [
        { text: "a", start: 1000, end: 1500 },
        { text: "b", start: 1500, end: 2000 },
      ],
      getVideoElement: () => ({ currentTime: 0 }) as HTMLVideoElement,
      getSourceLanguage: () => "en",
      providerRef: LOCAL_REF,
    })

    ;(pipeline as any).replaceProcessedChunk(
      [
        { text: "a", start: 1000, end: 1500 },
        { text: "b", start: 1500, end: 2000 },
      ],
      [{ text: "recut", start: 1000, end: 2000 }],
    )

    expect(pipeline.processedFragments).toEqual([
      { text: "recut", start: 1000, end: 2000 },
      { text: "after", start: 2000, end: 3000 },
    ])
  })

  // The AI call is in flight when the session is stopped, and its result arrives after the stop.
  // Fulfilled or rejected, it must not touch the processed cues or tell the adapter; the chunk it
  // was for must be given back (not left marked as done), so that the next start segments it
  // again. Only what the pipeline defines is asserted: the late result is observed after the
  // old loop has ended, before any new start.
  it.each([
    {
      branch: "fulfilment",
      arrive: (late: ReturnType<typeof createDeferred<SubtitlesFragment[]>>) =>
        late.resolve([{ ...LATE_CUE }]),
    },
    {
      branch: "rejection",
      arrive: (late: ReturnType<typeof createDeferred<SubtitlesFragment[]>>) =>
        late.reject(new Error("late AI failure")),
    },
  ])(
    "ignores a late $branch after stop, gives the chunk back, and the next start segments it",
    async ({ arrive }) => {
      const onChunkSegmented = vi.fn<ChunkSegmentedHandler>()
      const aiCallsBefore = vi.mocked(aiSegmentBlock).mock.calls.length
      const late = createDeferred<SubtitlesFragment[]>()
      vi.mocked(aiSegmentBlock)
        .mockImplementationOnce(() => late.promise)
        .mockImplementationOnce(async () => [{ ...AI_CUE }])
      const pipeline = createPipeline({ providerRef: LOCAL_REF, onChunkSegmented })

      // The first run is inside the AI call when the session stops.
      pipeline.start()
      await untilAiCalls(1, aiCallsBefore)
      expect(pipeline.isRunning).toBe(true)
      pipeline.stop()

      // The result arrives after the stop; the old loop then ends by itself.
      arrive(late)
      await settle(pipeline)

      expect(onChunkSegmented).not.toHaveBeenCalled()
      // Neither the late result nor the local fallback replaced anything.
      expect(
        pipeline.processedFragments,
        "a result that arrived after stop must not replace any cue",
      ).toEqual([STALE_CUE, OUTSIDE_CUE])
      // The chunk was handed back: it is not recorded as segmented, nor as an AI failure.
      expect(
        pipeline.hasUnprocessedChunks(),
        "the chunk must be given back after stop, not stay marked as segmented",
      ).toBe(true)
      pipeline.clearFailedStarts()
      expect(
        pipeline.hasUnprocessedChunks(),
        "a result that arrived after stop must not be recorded as an AI failure",
      ).toBe(true)

      // A new start segments that same chunk again, normally.
      pipeline.start()
      await settle(pipeline)

      expect(vi.mocked(aiSegmentBlock).mock.calls.length - aiCallsBefore).toBe(2)
      expect(vi.mocked(aiSegmentBlock).mock.calls[aiCallsBefore + 1]).toEqual([
        rawCues(),
        LOCAL_REF,
      ])
      expect(pipeline.processedFragments).toEqual([AI_CUE, OUTSIDE_CUE])
      expect(onChunkSegmented).toHaveBeenCalledTimes(1)
      expect(onChunkSegmented).toHaveBeenCalledWith(rawCues(), [AI_CUE])
      expect(pipeline.hasUnprocessedChunks()).toBe(false)
    },
  )
})
