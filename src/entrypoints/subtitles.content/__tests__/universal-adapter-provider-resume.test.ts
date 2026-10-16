// A subtitle session that is switched off and on again is resumed, not rebuilt, when the video, the
// track and the target language are the same. The resume did not ask whether the subtitles provider
// was still the one the session was built with, so the segmentation pipeline went on segmenting with
// the provider (or model) of the earlier run while every line translation read the settings as they
// stood: a mix of two providers for one video.
//
// The real adapter, scheduler, translation coordinator, segmentation pipeline and translator run
// here. Only the messaging boundary (which provider is reached, with which ref) and the stored
// settings are test doubles; segmentation and translation answers are deferred promises where the
// order of events matters. No provider, paid or free, is ever reached from this file.

import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { SUBTITLES_SOURCE } from "@/utils/constants/subtitles"
import { optimizeSubtitles } from "@/utils/subtitles/processor/optimizer"
import {
  adPlayingAtom,
  nativeSubtitleTranslationBlockedAtom,
  sourceTrackAtom,
  subtitlesSourceAtom,
  subtitlesStore,
  translatedTrackAtom,
} from "../atoms"
import { SubtitlesScheduler } from "../subtitles-scheduler"
import { UniversalVideoAdapter } from "../universal-adapter"

const mocks = vi.hoisted(() => ({
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
  sendMessage: vi.fn<(...args: any[]) => any>(),
  showSubtitlesErrorToast: vi.fn<(...args: any[]) => any>(),
  showAiSubtitlesWallToast: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/subtitles/toast", () => ({
  showSubtitlesErrorToast: mocks.showSubtitlesErrorToast,
  showAiSubtitlesWallToast: mocks.showAiSubtitlesWallToast,
}))

vi.mock("@/utils/config/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/config/storage")>()
  return { ...actual, getLocalConfig: mocks.getLocalConfig }
})

// The messaging boundary: which provider a request names is all these tests read from it.
vi.mock("@/utils/message", () => ({
  sendMessage: mocks.sendMessage,
  onMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/prompts/subtitles", () => ({
  getSubtitlesTranslatePrompt: vi
    .fn<(...args: any[]) => any>()
    .mockResolvedValue({ systemPrompt: "system", prompt: "prompt" }),
  getSubtitlesPromptTemplate: vi
    .fn<(...args: any[]) => any>()
    .mockResolvedValue({ systemPrompt: "template", prompt: "{{input}}" }),
}))

const VIDEO_ID = "video-1"
const PROVIDER_A = "provider-a"
const PROVIDER_B = "provider-b"

/** The cues the AI segmentation sees: the first three are in reach, the last three far ahead. */
// A pause longer than the recut's pause timeout separates the cues, so the rule-based recut keeps
// the three cues of a region apart and a region's cues can be counted.
const EARLY_CUES: SubtitlesFragment[] = [
  { text: "The first early line.", start: 0, end: 1_500 },
  { text: "The second early line.", start: 3_000, end: 4_500 },
  { text: "The third early line.", start: 6_000, end: 7_500 },
]
const LATE_CUES: SubtitlesFragment[] = [
  { text: "The first far line.", start: 200_000, end: 201_500 },
  { text: "The second far line.", start: 203_000, end: 204_500 },
  { text: "The third far line.", start: 206_000, end: 207_500 },
]
const CUES = [...EARLY_CUES, ...LATE_CUES]
const LATE_START_S = 200

interface ProviderSetting {
  id: string
  apiKey?: string
  model?: string
}

// The settings as they stand right now. The mocked storage reads this per call, as the real one
// reads the stored config per call.
let provider: ProviderSetting = { id: PROVIDER_A }
let providersInSettings: ProviderSetting[] = [{ id: PROVIDER_A }, { id: PROVIDER_B }]
let targetCode = "kor"

const providerConfig = ({ id, apiKey, model }: ProviderSetting) => {
  const config = structuredClone(DEFAULT_PROVIDER_CONFIG.openai)
  return {
    ...config,
    id,
    name: id,
    enabled: true,
    apiKey: apiKey ?? `key-of-${id}`,
    model: model ? { ...config.model, model } : config.model,
  }
}

const currentConfig = () => ({
  ...DEFAULT_CONFIG,
  language: { ...DEFAULT_CONFIG.language, sourceCode: "eng", targetCode },
  providersConfig: providersInSettings.map(providerConfig),
  glossary: { ...DEFAULT_CONFIG.glossary, enabled: false },
  pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, enableAIContentAware: false },
  videoSubtitles: {
    ...DEFAULT_CONFIG.videoSubtitles,
    aiSegmentation: true,
    providerId: provider.id,
    style: { ...DEFAULT_CONFIG.videoSubtitles.style, displayMode: "bilingual" },
  },
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

// Everything queued on the microtask queue has run once this resolves.
const settle = async () => {
  for (let round = 0; round < 3; round++) await new Promise<void>((done) => setTimeout(done, 0))
}

interface SeenRequest {
  providerId: string
  model: string | undefined
  text: string
}

// What reached the (mocked) provider boundary, in order.
let segmentationRequests: SeenRequest[] = []
let translationRequests: SeenRequest[] = []

interface Hold {
  data: { jsonContent: string; providerRef: { config: { id: string } } } | null
  promise: Promise<string>
  release: (mark?: string) => void
}

// Segmentation / translation answers the next calls wait on instead of answering at once.
let segmentationHolds: Hold[] = []
let translationHolds: Array<Deferred<string>> = []

const toVtt = (jsonContent: string, mark?: string) =>
  [
    "WEBVTT",
    "",
    ...(JSON.parse(jsonContent) as Array<{ s: number; e: number; t: string }>).flatMap((cue) => [
      `${cue.s} --> ${cue.e}`,
      mark ? `${cue.t} ${mark}` : cue.t,
      "",
    ]),
  ].join("\n")

function holdNextSegmentation(): Hold {
  const answer = deferred<string>()
  const hold: Hold = {
    data: null,
    promise: answer.promise,
    release: (mark) => answer.resolve(toVtt(hold.data!.jsonContent, mark)),
  }
  segmentationHolds.push(hold)
  return hold
}

function holdNextTranslation(): Deferred<string> {
  const answer = deferred<string>()
  translationHolds.push(answer)
  return answer
}

function installTransport() {
  mocks.sendMessage.mockImplementation((name: string, data: any) => {
    if (name === "aiSegmentSubtitles") {
      segmentationRequests.push({
        providerId: data.providerRef.config.id,
        model: data.providerRef.config.model?.model,
        text: data.jsonContent,
      })
      const hold = segmentationHolds.shift()
      if (hold) {
        hold.data = data
        return hold.promise
      }
      return Promise.resolve(toVtt(data.jsonContent))
    }
    if (name === "enqueueSubtitlesTranslateRequest") {
      translationRequests.push({
        providerId: data.providerRef.config.id,
        model: data.providerRef.config.model?.model,
        text: data.text,
      })
      const hold = translationHolds.shift()
      return hold ? hold.promise : Promise.resolve(`${data.providerRef.config.id}:${data.text}`)
    }
    return Promise.resolve(undefined)
  })
}

function makeFetcher(sourceLanguage: string, cues: SubtitlesFragment[]) {
  return {
    fetch: vi.fn<(...args: any[]) => any>().mockResolvedValue(cues),
    cleanup: vi.fn<(...args: any[]) => any>(),
    // The same track every time: only the viewer's settings move in these scenarios.
    shouldUseSameTrack: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
    getSourceLanguage: vi.fn<() => string>(() => sourceLanguage),
    hasAvailableSubtitles: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
    // Not a segmented track: the AI segmentation path runs.
    isPreSegmented: () => false,
  }
}

/** A player with a real scheduler, coordinator, pipeline and translator. */
function openVideo({
  sourceLanguage = "en",
  cues = CUES,
}: { sourceLanguage?: string; cues?: SubtitlesFragment[] } = {}) {
  const nativeFetcher = makeFetcher(sourceLanguage, cues)
  const listeners = new Map<string, Set<() => void>>()
  const video = {
    currentTime: 0.5,
    playbackRate: 1,
    paused: false,
    addEventListener: vi.fn<(...args: any[]) => any>((type: string, listener: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    }),
    removeEventListener: vi.fn<(...args: any[]) => any>((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener)
    }),
  }
  const adapter = new UniversalVideoAdapter({
    config: {
      selectors: {
        video: "video",
        playerContainer: ".player",
        controlsBar: ".controls",
        nativeSubtitles: ".native-subtitles",
      },
      events: {},
      getVideoId: () => VIDEO_ID,
    },
    fetchers: { native: () => nativeFetcher, ai: () => nativeFetcher },
  })
  vi.spyOn(adapter as any, "hideNativeSubtitles").mockImplementation(() => {})
  vi.spyOn(adapter as any, "showNativeSubtitles").mockImplementation(() => {})
  const scheduler = new SubtitlesScheduler({ videoElement: video as unknown as HTMLVideoElement })
  scheduler.start()
  scheduler.hide()
  ;(adapter as any).subtitlesScheduler = scheduler

  /** The viewer moves the playhead: what the player fires when it does. */
  const seekTo = async (seconds: number) => {
    video.currentTime = seconds
    for (const type of ["seeked", "timeupdate"]) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    }
    await settle()
  }
  return { adapter, nativeFetcher, scheduler, video, seekTo }
}

type Player = ReturnType<typeof openVideo>

const switchOn = async ({ adapter }: Player) => {
  adapter.toggleSubtitlesManually(true)
  await settle()
}
const switchOff = ({ adapter }: Player) => adapter.toggleSubtitlesManually(false)

/** The viewer saves another provider (or another model) for the subtitles in the settings. */
const saveProvider = (next: ProviderSetting) => {
  provider = next
  providersInSettings = [
    ...providersInSettings.filter((existing) => existing.id !== next.id),
    next,
  ].sort((a, b) => a.id.localeCompare(b.id))
}

const internals = (adapter: UniversalVideoAdapter) =>
  adapter as unknown as {
    translationCoordinator: object | null
    segmentationPipeline: { processedFragments: SubtitlesFragment[] } | null
  }

/** What the viewer reads as the source text: the cue texts the player holds for the source track. */
const sourceTexts = () => subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)
const translatedTexts = () => subtitlesStore.get(translatedTrackAtom).map((cue) => cue.translation)
const providersOf = (requests: SeenRequest[]) => [...new Set(requests.map((r) => r.providerId))]

beforeEach(() => {
  vi.clearAllMocks()
  provider = { id: PROVIDER_A }
  providersInSettings = [{ id: PROVIDER_A }, { id: PROVIDER_B }]
  targetCode = "kor"
  segmentationRequests = []
  translationRequests = []
  segmentationHolds = []
  translationHolds = []
  subtitlesStore.set(sourceTrackAtom, [])
  subtitlesStore.set(translatedTrackAtom, [])
  subtitlesStore.set(adPlayingAtom, false)
  subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
  subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
  vi.stubGlobal("document", { title: "Test video", querySelector: () => null })
  mocks.getLocalConfig.mockImplementation(async () => currentConfig())
  installTransport()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  subtitlesStore.set(translatedTrackAtom, [])
  subtitlesStore.set(sourceTrackAtom, [])
  subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
})

describe("resuming a subtitle session after the subtitles provider was changed", () => {
  describe("the provider changed while the captions were off", () => {
    it("sends the segmentation of the region not yet processed to the new provider, not the old one", async () => {
      const player = openVideo()
      await switchOn(player)
      // The run under provider A segmented what was in reach and translated it.
      expect(providersOf(segmentationRequests)).toEqual([PROVIDER_A])
      expect(providersOf(translationRequests)).toEqual([PROVIDER_A])

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      const seenBefore = segmentationRequests.length
      await switchOn(player)
      // The viewer moves on to a region that was never segmented.
      await player.seekTo(LATE_START_S)

      const lateRequests = segmentationRequests
        .slice(seenBefore)
        .filter((request) => request.text.includes("far line"))
      // The region was segmented after the resume, and by the provider the viewer chose.
      expect(lateRequests.length).toBeGreaterThan(0)
      expect(providersOf(lateRequests)).toEqual([PROVIDER_B])
    })

    it("uses one provider after the resume: segmentation and line translation both name the new one", async () => {
      const player = openVideo()
      await switchOn(player)

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      const segmentedBefore = segmentationRequests.length
      const translatedBefore = translationRequests.length
      await switchOn(player)
      await player.seekTo(LATE_START_S)

      const segmentedAfter = segmentationRequests.slice(segmentedBefore)
      const translatedAfter = translationRequests.slice(translatedBefore)
      expect(segmentedAfter.length).toBeGreaterThan(0)
      expect(translatedAfter.filter((request) => request.text.includes("far line"))).toHaveLength(3)
      expect([...providersOf(segmentedAfter), ...providersOf(translatedAfter)]).toEqual([
        PROVIDER_B,
        PROVIDER_B,
      ])
    })

    it("counts another model of the same provider as a change", async () => {
      provider = { id: PROVIDER_A, model: "model-one" }
      providersInSettings = [provider]
      const player = openVideo()
      await switchOn(player)
      expect(segmentationRequests.map((request) => request.model)).toEqual(["model-one"])

      switchOff(player)
      saveProvider({ id: PROVIDER_A, model: "model-two" })
      const seenBefore = segmentationRequests.length
      await switchOn(player)
      await player.seekTo(LATE_START_S)

      const lateRequests = segmentationRequests
        .slice(seenBefore)
        .filter((request) => request.text.includes("far line"))
      expect(lateRequests.length).toBeGreaterThan(0)
      expect(lateRequests.map((request) => request.model)).toEqual(["model-two"])
    })

    it("counts a provider replaced by another under the same setting as a change", async () => {
      const player = openVideo()
      await switchOn(player)

      // The old provider is removed from the settings and the new one takes its place.
      switchOff(player)
      providersInSettings = [{ id: PROVIDER_B }]
      provider = { id: PROVIDER_B }
      const seenBefore = segmentationRequests.length
      await switchOn(player)
      await player.seekTo(LATE_START_S)

      const lateRequests = segmentationRequests
        .slice(seenBefore)
        .filter((request) => request.text.includes("far line"))
      expect(lateRequests.length).toBeGreaterThan(0)
      expect(providersOf(lateRequests)).toEqual([PROVIDER_B])
    })
  })

  describe("a segmentation request of the old provider that was in flight when the captions went off", () => {
    it("is not applied once the session was resumed with the new provider", async () => {
      const player = openVideo()
      await switchOn(player)

      // The viewer is at the far region; provider A's segmentation of it is still on its way.
      const inFlight = holdNextSegmentation()
      await player.seekTo(LATE_START_S)
      expect(
        segmentationRequests.filter((request) => request.text.includes("far line")),
      ).toHaveLength(1)

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      await switchOn(player)

      // A answers late, after the captions are back on with provider B.
      inFlight.release("fromProviderA")
      await settle()

      expect(sourceTexts().join(" ")).not.toContain("fromProviderA")
      expect(translatedTexts().join(" ")).not.toContain("fromProviderA")
      expect(
        internals(player.adapter)
          .segmentationPipeline!.processedFragments.map((cue) => cue.text)
          .join(" "),
      ).not.toContain("fromProviderA")
    })

    it("does not keep the far region from being segmented by the new provider", async () => {
      const player = openVideo()
      await switchOn(player)
      const inFlight = holdNextSegmentation()
      await player.seekTo(LATE_START_S)

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      const seenBefore = segmentationRequests.length
      await switchOn(player)
      inFlight.release("fromProviderA")
      await settle()

      const afterResume = segmentationRequests
        .slice(seenBefore)
        .filter((request) => request.text.includes("far line"))
      expect(afterResume.length).toBeGreaterThan(0)
      expect(providersOf(afterResume)).toEqual([PROVIDER_B])
    })
  })

  describe("controls that hold before and after the change", () => {
    it("resumes with the same provider without restarting anything: same coordinator, same pipeline, no new request", async () => {
      const player = openVideo()
      await switchOn(player)
      const coordinator = internals(player.adapter).translationCoordinator
      const pipeline = internals(player.adapter).segmentationPipeline
      const segmentedBefore = segmentationRequests.length
      const translatedBefore = translationRequests.length

      switchOff(player)
      await switchOn(player)

      expect(internals(player.adapter).translationCoordinator).toBe(coordinator)
      expect(internals(player.adapter).segmentationPipeline).toBe(pipeline)
      expect(segmentationRequests).toHaveLength(segmentedBefore)
      expect(translationRequests).toHaveLength(translatedBefore)
      expect(player.nativeFetcher.fetch).toHaveBeenCalledTimes(1)
    })

    it("keeps using the same provider for the far region after a resume that changed nothing", async () => {
      const player = openVideo()
      await switchOn(player)
      switchOff(player)
      const seenBefore = segmentationRequests.length
      await switchOn(player)
      await player.seekTo(LATE_START_S)

      const lateRequests = segmentationRequests
        .slice(seenBefore)
        .filter((request) => request.text.includes("far line"))
      expect(lateRequests.length).toBeGreaterThan(0)
      expect(providersOf(lateRequests)).toEqual([PROVIDER_A])
    })

    it("keeps the viewer's switch-off: saving another provider does not turn the captions back on", async () => {
      const player = openVideo()
      await switchOn(player)

      switchOff(player)
      const segmentedBefore = segmentationRequests.length
      const translatedBefore = translationRequests.length
      saveProvider({ id: PROVIDER_B })
      await player.seekTo(LATE_START_S)
      await settle()

      // Nothing runs while the captions are off, and no session is started on the setting alone.
      expect(segmentationRequests).toHaveLength(segmentedBefore)
      expect(translationRequests).toHaveLength(translatedBefore)
      expect((player.adapter as any).manualChoice).toEqual({ videoId: VIDEO_ID, on: false })
    })

    it("does not let a translation of the earlier run, still in flight, overwrite the resumed run's", async () => {
      const player = openVideo()
      const slow = holdNextTranslation()
      const slowSecond = holdNextTranslation()
      const slowThird = holdNextTranslation()
      await switchOn(player)
      expect(translationRequests).toHaveLength(3)

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      await switchOn(player)
      slow.resolve("late-from-the-earlier-run-1")
      slowSecond.resolve("late-from-the-earlier-run-2")
      slowThird.resolve("late-from-the-earlier-run-3")
      await settle()

      expect(translatedTexts().join(" ")).not.toContain("late-from-the-earlier-run")
      expect(translatedTexts().sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
        `${PROVIDER_B}:The first early line.`,
        `${PROVIDER_B}:The second early line.`,
        `${PROVIDER_B}:The third early line.`,
      ])
    })

    it("shows the source text as it is: the cue texts do not change when the provider does", async () => {
      const player = openVideo()
      await switchOn(player)
      const before = sourceTexts().join(" ")
      expect(before).toContain("The first early line.")
      expect(before).toContain("The third far line.")

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      await switchOn(player)
      await player.seekTo(LATE_START_S)

      const after = sourceTexts().join(" ")
      expect(after).toContain("The first early line.")
      expect(after).toContain("The third far line.")
      expect(after.split(/\s+/).sort()).toEqual(before.split(/\s+/).sort())
    })

    it("treats a Korean track as before: the same cues, cut by the same rules, whichever provider cut them", async () => {
      const koreanCues: SubtitlesFragment[] = [
        { text: "안녕하세요 여러분", start: 0, end: 1_500 },
        { text: "오늘은 자막 이야기를 합니다", start: 2_000, end: 4_500 },
      ]
      const expected = optimizeSubtitles(koreanCues, "ko").map((cue) => cue.text)
      targetCode = "eng"
      const player = openVideo({ sourceLanguage: "ko", cues: koreanCues })
      await switchOn(player)
      expect(sourceTexts()).toEqual(expected)

      switchOff(player)
      saveProvider({ id: PROVIDER_B })
      await switchOn(player)

      expect(sourceTexts()).toEqual(expected)
      // Translated from the same cues; which provider answered is not what this checks.
      expect(translatedTexts().map((text) => text?.replace(/^provider-[ab]:/, ""))).toEqual(
        expected,
      )
    })
  })
})
