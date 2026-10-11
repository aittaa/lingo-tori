import type { Config } from "@/types/config/config"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { subtitlesStore, SubtitleCopyPhase, translatedSubtitlesCopyStatusAtom } from "../atoms"
import { TranslatedSubtitlesExporter } from "../translated-subtitles-exporter"

const mocks = vi.hoisted(() => ({
  aiSegmentBlock: vi.fn<(...args: any[]) => any>(),
  buildSubtitlesSrtContent: vi.fn<(...args: any[]) => any>().mockReturnValue("prepared SRT"),
  copySubtitlesText: vi.fn<(...args: any[]) => any>(),
  fetchSubtitlesSummary: vi.fn<(...args: any[]) => any>(),
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
  resolveSubtitlesProviderRef: vi.fn<(...args: any[]) => any>(),
  toastAdd: vi.fn<(...args: any[]) => any>(),
  translateSubtitles: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: mocks.getLocalConfig }))
vi.mock("@/utils/subtitles/processor/ai-segmentation", () => ({
  aiSegmentBlock: mocks.aiSegmentBlock,
}))
vi.mock("@/utils/subtitles/processor/translator", () => ({
  buildSubtitlesSummaryContextHash: () => "summary-hash",
  resolveSubtitlesProviderRef: mocks.resolveSubtitlesProviderRef,
  fetchSubtitlesSummary: mocks.fetchSubtitlesSummary,
  translateSubtitles: mocks.translateSubtitles,
}))
vi.mock("@/utils/subtitles/srt", () => ({
  buildSubtitlesSrtContent: mocks.buildSubtitlesSrtContent,
  copySubtitlesText: mocks.copySubtitlesText,
}))

function createConfig({
  aiSegmentation = false,
  targetCode = "cmn",
}: {
  aiSegmentation?: boolean
  targetCode?: Config["language"]["targetCode"]
} = {}): Config {
  const provider = DEFAULT_PROVIDER_CONFIG.openai
  return {
    ...DEFAULT_CONFIG,
    language: { ...DEFAULT_CONFIG.language, sourceCode: "eng", targetCode },
    providersConfig: [provider],
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId: provider.id, aiSegmentation },
  }
}

function createExporter(fragments: SubtitlesFragment[], preSegmented = true) {
  const fetcher = {
    fetch: vi.fn<(...args: any[]) => any>().mockResolvedValue(fragments),
    cleanup: vi.fn<(...args: any[]) => any>(),
    shouldUseSameTrack: vi.fn<(...args: any[]) => any>().mockResolvedValue(false),
    getSourceLanguage: () => "en",
    hasAvailableSubtitles: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
    isPreSegmented: () => preSegmented,
  }
  return {
    exporter: new TranslatedSubtitlesExporter(() => fetcher, {
      selectors: {
        video: "video",
        playerContainer: ".player",
        controlsBar: ".controls",
        nativeSubtitles: ".native",
      },
      events: {},
      getVideoId: () => "video-id",
    }),
    fetcher,
  }
}

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    text: `Line ${index + 1}.`,
    start: index * 1000,
    end: (index + 1) * 1000,
  }))
}

function translated(fragments: SubtitlesFragment[]) {
  return fragments.map((fragment) => ({ ...fragment, translation: `zh:${fragment.text}` }))
}

function status() {
  return subtitlesStore.get(translatedSubtitlesCopyStatusAtom)
}

describe("translatedSubtitlesExporter", () => {
  afterEach(() => vi.unstubAllGlobals())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.stubGlobal("document", { title: "Test video" })
    subtitlesStore.set(translatedSubtitlesCopyStatusAtom, {
      phase: SubtitleCopyPhase.Idle,
      progress: null,
    })
    mocks.getLocalConfig.mockResolvedValue(createConfig())
    // The export resolves one ref up front and threads it into segmentation;
    // a null here would skip the AI path entirely.
    mocks.resolveSubtitlesProviderRef.mockResolvedValue({
      kind: "local",
      config: DEFAULT_PROVIDER_CONFIG.openai,
    })
    mocks.fetchSubtitlesSummary.mockResolvedValue(null)
    mocks.translateSubtitles.mockImplementation(async (fragments: SubtitlesFragment[]) =>
      translated(fragments),
    )
  })

  it("uses one config snapshot while reporting batch progress and preparing the full SRT without writing the clipboard", async () => {
    const config = createConfig()
    const fragments = lines(6)
    const { exporter } = createExporter(fragments)
    const statuses: Array<ReturnType<typeof status>> = []
    mocks.getLocalConfig.mockResolvedValue(config)
    const unsubscribe = subtitlesStore.sub(translatedSubtitlesCopyStatusAtom, () =>
      statuses.push(status()),
    )

    await exporter.copy()
    unsubscribe()

    expect(mocks.getLocalConfig).toHaveBeenCalledTimes(1)
    expect(mocks.copySubtitlesText).not.toHaveBeenCalled()
    // The summary reuses the export's narrowed session ref instead of
    // re-resolving one of its own.
    expect(mocks.fetchSubtitlesSummary).toHaveBeenCalledWith(expect.any(Object), config, {
      kind: "local",
      config: DEFAULT_PROVIDER_CONFIG.openai,
    })
    expect(mocks.translateSubtitles).toHaveBeenNthCalledWith(
      1,
      fragments.slice(0, 5),
      expect.any(Object),
      config,
    )
    expect(mocks.translateSubtitles).toHaveBeenNthCalledWith(
      2,
      fragments.slice(5),
      expect.any(Object),
      config,
    )
    expect(statuses).toEqual(
      expect.arrayContaining([
        { phase: SubtitleCopyPhase.Checking, progress: null },
        { phase: SubtitleCopyPhase.Preparing, progress: 0 },
        { phase: SubtitleCopyPhase.Translating, progress: 83 },
        { phase: SubtitleCopyPhase.Translating, progress: 100 },
        { phase: SubtitleCopyPhase.Ready, progress: null },
      ]),
    )
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith(
      translated(fragments).map(({ translation, ...fragment }) => ({
        ...fragment,
        text: translation,
      })),
    )
  })

  it("translates exported SRT batches with a bounded two-batch window", async () => {
    const fragments = lines(15)
    const resolvers: Array<(value: SubtitlesFragment[]) => void> = []
    let activeBatches = 0
    let maxActiveBatches = 0
    mocks.translateSubtitles.mockImplementation(async () => {
      activeBatches += 1
      maxActiveBatches = Math.max(maxActiveBatches, activeBatches)
      const translatedBatch = await new Promise<SubtitlesFragment[]>((resolve) =>
        resolvers.push(resolve),
      )
      activeBatches -= 1
      return translatedBatch
    })
    const { exporter } = createExporter(fragments)

    const preparation = exporter.copy()
    await vi.waitFor(() => expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2))

    expect(maxActiveBatches).toBe(2)
    expect(mocks.translateSubtitles).toHaveBeenNthCalledWith(
      1,
      fragments.slice(0, 5),
      expect.any(Object),
      expect.any(Object),
    )
    expect(mocks.translateSubtitles).toHaveBeenNthCalledWith(
      2,
      fragments.slice(5, 10),
      expect.any(Object),
      expect.any(Object),
    )

    resolvers[1]!(translated(fragments.slice(5, 10)))
    await vi.waitFor(() => expect(activeBatches).toBe(1))
    expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2)

    resolvers[0]!(translated(fragments.slice(0, 5)))
    await vi.waitFor(() => expect(mocks.translateSubtitles).toHaveBeenCalledTimes(3))
    expect(mocks.translateSubtitles).toHaveBeenNthCalledWith(
      3,
      fragments.slice(10),
      expect.any(Object),
      expect.any(Object),
    )

    resolvers[2]!(translated(fragments.slice(10)))
    await preparation

    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith(
      translated(fragments).map(({ translation, ...fragment }) => ({
        ...fragment,
        text: translation,
      })),
    )
  })

  it("fails closed when one concurrent export batch fails", async () => {
    const fragments = lines(10)
    let finishSlowBatch!: (value: SubtitlesFragment[]) => void
    mocks.translateSubtitles
      .mockRejectedValueOnce(new Error("Batch failed"))
      .mockImplementationOnce(
        async () =>
          await new Promise<SubtitlesFragment[]>((resolve) => {
            finishSlowBatch = resolve
          }),
      )
    const { exporter } = createExporter(fragments)

    const preparation = exporter.copy()
    await vi.waitFor(() => expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2))
    await preparation

    expect(mocks.buildSubtitlesSrtContent).not.toHaveBeenCalled()
    expect(mocks.toastAdd).toHaveBeenCalledWith({ type: "error", title: "Batch failed" })
    expect(status()).toEqual({ phase: SubtitleCopyPhase.Idle, progress: null })

    finishSlowBatch(translated(fragments.slice(5)))
    await vi.waitFor(() =>
      expect(status()).toEqual({ phase: SubtitleCopyPhase.Idle, progress: null }),
    )
  })

  it.each([
    ["missing result", (fragments: SubtitlesFragment[]) => translated(fragments.slice(0, -1))],
    [
      "empty translation",
      (fragments: SubtitlesFragment[]) =>
        fragments.map((fragment) => ({ ...fragment, translation: "" })),
    ],
  ])("fails closed for an incomplete batch: %s", async (_, resultFor) => {
    const fragments = lines(5)
    mocks.translateSubtitles.mockResolvedValue(resultFor(fragments))

    await createExporter(fragments).exporter.copy()

    expect(mocks.buildSubtitlesSrtContent).not.toHaveBeenCalled()
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "subtitles.errors.translatedExportIncomplete",
    })
    expect(status()).toEqual({ phase: SubtitleCopyPhase.Idle, progress: null })
  })

  it("rejects same-language export before showing the preparing state", async () => {
    mocks.getLocalConfig.mockResolvedValue(createConfig({ targetCode: "eng" }))
    const statuses: Array<ReturnType<typeof status>> = []
    const unsubscribe = subtitlesStore.sub(translatedSubtitlesCopyStatusAtom, () =>
      statuses.push(status()),
    )

    await createExporter(lines(1)).exporter.copy()
    unsubscribe()

    expect(mocks.translateSubtitles).not.toHaveBeenCalled()
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "subtitles.errors.translatedExportSameLanguage",
    })
    expect(statuses).toEqual([
      { phase: SubtitleCopyPhase.Checking, progress: null },
      { phase: SubtitleCopyPhase.Idle, progress: null },
    ])
  })

  it("prevents concurrent duplicate preparations", async () => {
    let finish!: () => void
    mocks.translateSubtitles.mockImplementation(async (fragments: SubtitlesFragment[]) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return translated(fragments)
    })
    const { exporter, fetcher } = createExporter(lines(1))

    const first = exporter.copy()
    await vi.waitFor(() => expect(mocks.translateSubtitles).toHaveBeenCalled())
    const second = exporter.copy()
    finish()
    await Promise.all([first, second])

    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledTimes(1)
  })

  it("invalidates an in-flight export on dispose and allows a new preparation", async () => {
    const fragments = lines(10)
    const finishOldTranslations: Array<(value: SubtitlesFragment[]) => void> = []
    mocks.translateSubtitles.mockImplementation(async (batch: SubtitlesFragment[]) => {
      if (finishOldTranslations.length < 2) {
        return await new Promise<SubtitlesFragment[]>((resolve) =>
          finishOldTranslations.push(resolve),
        )
      }
      return translated(batch)
    })
    const { exporter, fetcher } = createExporter(fragments)

    const oldPreparation = exporter.copy()
    await vi.waitFor(() => expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2))
    exporter.dispose()
    const newPreparation = exporter.copy()
    await vi.waitFor(() => expect(mocks.translateSubtitles).toHaveBeenCalledTimes(4))
    await newPreparation
    finishOldTranslations[0]!(translated(fragments.slice(0, 5)))
    finishOldTranslations[1]!(translated(fragments.slice(5)))
    await oldPreparation

    expect(fetcher.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledTimes(1)
    expect(mocks.toastAdd).not.toHaveBeenCalled()
    expect(status().phase).toBe(SubtitleCopyPhase.Ready)
  })

  it("falls back to optimized source timing when AI segmentation fails", async () => {
    mocks.getLocalConfig.mockResolvedValue(createConfig({ aiSegmentation: true }))
    mocks.aiSegmentBlock.mockRejectedValue(new Error("Segmentation failed"))

    await createExporter(
      [
        { text: "Hello.", start: 0, end: 1000 },
        { text: "World.", start: 1000, end: 2000 },
      ],
      false,
    ).exporter.copy()

    expect(mocks.aiSegmentBlock).toHaveBeenCalledTimes(1)
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith([
      { text: "zh:Hello. World.", start: 0, end: 2000 },
    ])
  })

  it("never sends a translate-only provider on a doomed segmentation prompt", async () => {
    // DeepLX resolves fine for videoSubtitles — the capability gate is the
    // wider translate one — but it has no model to prompt, so the export must
    // take the rule-based path without one aiSegmentBlock round trip per chunk.
    mocks.getLocalConfig.mockResolvedValue(createConfig({ aiSegmentation: true }))
    mocks.resolveSubtitlesProviderRef.mockResolvedValue({
      kind: "local",
      config: DEFAULT_PROVIDER_CONFIG.deeplx,
    })

    await createExporter(
      [
        { text: "Hello.", start: 0, end: 1000 },
        { text: "World.", start: 1000, end: 2000 },
      ],
      false,
    ).exporter.copy()

    expect(mocks.aiSegmentBlock).not.toHaveBeenCalled()
    // The summary is a generation too: the exporter hands it a null session
    // ref rather than letting it re-resolve the unpromptable provider.
    expect(mocks.fetchSubtitlesSummary).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      null,
    )
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith([
      { text: "zh:Hello. World.", start: 0, end: 2000 },
    ])
    expect(status().phase).toBe(SubtitleCopyPhase.Ready)
  })

  it("retries unsafe AI segmentation with smaller chunks before falling back", async () => {
    const source = [
      {
        text: "The first half of this transcript segment has enough words to stay readable.",
        start: 0,
        end: 29000,
      },
      {
        text: "The second half should be exported with its original safe timing after retry.",
        start: 30000,
        end: 59000,
      },
    ]
    const retryFirst = [{ ...source[0], text: "Retried first half." }]
    const retrySecond = [{ ...source[1], text: "Retried second half." }]
    mocks.getLocalConfig.mockResolvedValue(createConfig({ aiSegmentation: true }))
    mocks.aiSegmentBlock
      .mockResolvedValueOnce([{ text: "Collapsed.", start: 0, end: 1 }])
      .mockResolvedValueOnce(retryFirst)
      .mockResolvedValueOnce(retrySecond)

    await createExporter(source, false).exporter.copy()

    expect(mocks.aiSegmentBlock).toHaveBeenCalledTimes(3)
    expect(mocks.aiSegmentBlock).toHaveBeenNthCalledWith(1, source, expect.any(Object))
    expect(mocks.aiSegmentBlock).toHaveBeenNthCalledWith(2, [source[0]], expect.any(Object))
    expect(mocks.aiSegmentBlock).toHaveBeenNthCalledWith(3, [source[1]], expect.any(Object))
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith([
      { text: "zh:Retried first half.", start: 0, end: 29000 },
      { text: "zh:Retried second half.", start: 30000, end: 59000 },
    ])
  })

  it("falls back to optimized source timing when AI segmentation creates overlapping export cues", async () => {
    const questionText =
      "I was wondering whether you have tested scaling laws when source text is transformed into image inputs across many different controlled experiments."
    mocks.getLocalConfig.mockResolvedValue(createConfig({ aiSegmentation: true }))
    mocks.aiSegmentBlock.mockResolvedValue([
      { text: "Hello.", start: 0, end: 3420 },
      { text: questionText, start: 500, end: 3420 },
    ])

    await createExporter(
      [
        { text: "Hello.", start: 0, end: 500 },
        { text: questionText, start: 500, end: 3420 },
      ],
      false,
    ).exporter.copy()

    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith([
      { text: "zh:Hello.", start: 0, end: 500 },
      { text: `zh:${questionText}`, start: 500, end: 3420 },
    ])
  })

  it("falls back when optimization hides a raw collapsed AI segment", async () => {
    mocks.getLocalConfig.mockResolvedValue(createConfig({ aiSegmentation: true }))
    mocks.aiSegmentBlock.mockResolvedValue([
      { text: "Hi.", start: 500, end: 501 },
      { text: "OK.", start: 501, end: 1000 },
    ])

    await createExporter(
      [
        { text: "Hi.", start: 0, end: 500 },
        { text: "OK.", start: 500, end: 1000 },
      ],
      false,
    ).exporter.copy()

    expect(mocks.aiSegmentBlock).toHaveBeenCalledTimes(1)
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith([
      { text: "zh:Hi. OK.", start: 0, end: 1000 },
    ])
  })

  it("falls back to optimized source timing when AI segmentation collapses a cue to a boundary", async () => {
    const followUpText =
      "Actually this next cue contains enough words that it should remain separate from the short greeting during subtitle optimization across many different transcript timing examples."
    mocks.getLocalConfig.mockResolvedValue(createConfig({ aiSegmentation: true }))
    mocks.aiSegmentBlock.mockResolvedValue([
      { text: "Hi.", start: 500, end: 501 },
      { text: followUpText, start: 501, end: 3500 },
    ])

    await createExporter(
      [
        { text: "Hi.", start: 0, end: 500 },
        { text: followUpText, start: 500, end: 3500 },
      ],
      false,
    ).exporter.copy()

    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalledWith([
      { text: "zh:Hi.", start: 0, end: 500 },
      { text: `zh:${followUpText}`, start: 500, end: 3500 },
    ])
  })

  it("continues without a summary when summary generation fails", async () => {
    mocks.fetchSubtitlesSummary.mockRejectedValue(new Error("Summary failed"))
    await createExporter(lines(1)).exporter.copy()

    expect(mocks.translateSubtitles).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ summary: null }),
      expect.any(Object),
    )
    expect(mocks.buildSubtitlesSrtContent).toHaveBeenCalled()
  })

  it("clears completion state when disposed", async () => {
    vi.useFakeTimers()
    const { exporter } = createExporter(lines(1))

    await exporter.copy()
    expect(status().phase).toBe(SubtitleCopyPhase.Ready)
    exporter.dispose()
    await vi.runAllTimersAsync()

    expect(status()).toEqual({ phase: SubtitleCopyPhase.Idle, progress: null })
  })
  it("does not write after asynchronous translation, then retries copy without new provider calls", async () => {
    const { exporter } = createExporter(lines(1))
    await exporter.copy()
    expect(mocks.copySubtitlesText).not.toHaveBeenCalled()
    expect(status().phase).toBe(SubtitleCopyPhase.Ready)
    mocks.copySubtitlesText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"))
    await exporter.copy()
    expect(status().phase).toBe(SubtitleCopyPhase.CopyFailed)
    const retry = exporter.copy()
    // The API is invoked before returning control to the caller, preserving the click.
    expect(mocks.copySubtitlesText).toHaveBeenCalledTimes(2)
    await retry
    expect(status().phase).toBe(SubtitleCopyPhase.Complete)
    expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
    expect(mocks.getLocalConfig).toHaveBeenCalledTimes(1)
    exporter.dispose()
  })

  it("rejects an empty source track without preparing clipboard data", async () => {
    await createExporter([]).exporter.copy()
    expect(mocks.translateSubtitles).not.toHaveBeenCalled()
    expect(mocks.buildSubtitlesSrtContent).not.toHaveBeenCalled()
    expect(mocks.copySubtitlesText).not.toHaveBeenCalled()
    expect(status().phase).toBe(SubtitleCopyPhase.Idle)
  })
})
