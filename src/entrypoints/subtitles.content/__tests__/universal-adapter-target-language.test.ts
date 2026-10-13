import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { SUBTITLES_SOURCE } from "@/utils/constants/subtitles"
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
  buildSubtitlesSummaryContextHash: vi.fn<(...args: any[]) => any>(() => null),
  fetchSubtitlesSummary: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
  translateSubtitles: vi.fn<(...args: any[]) => any>(),
  resolveSubtitlesProviderRef: vi.fn<(...args: any[]) => any>(),
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

// The messaging boundary: no provider, paid or free, is ever reached from this file.
vi.mock("@/utils/subtitles/processor/translator", () => ({
  buildSubtitlesSummaryContextHash: mocks.buildSubtitlesSummaryContextHash,
  resolveSubtitlesProviderRef: mocks.resolveSubtitlesProviderRef,
  fetchSubtitlesSummary: mocks.fetchSubtitlesSummary,
  translateSubtitles: mocks.translateSubtitles,
}))

const PROVIDER_ID = "subtitles-provider"
const VIDEO_ID = "A"
const CUES: SubtitlesFragment[] = [
  { text: "Hello", start: 0, end: 1000 },
  { text: "World", start: 2000, end: 3000 },
]

// The language the viewer has configured right now. The stubbed translator reads it per batch,
// as the real one reads the stored settings per batch.
let target = "kor"
// Starts the stubbed translator fails for, as a provider that rejects only some requests would.
const failing = new Set<number>()

const configFor = (targetCode: string) => ({
  language: { targetCode },
  providersConfig: [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true },
  ],
  videoSubtitles: {
    autoStart: false,
    aiSegmentation: false,
    providerId: PROVIDER_ID,
    style: { displayMode: "bilingual" },
  },
})

// Past this many requests nothing settles. A retry loop would otherwise spin on the microtask
// queue and starve the timers a test waits on; capped, it fails the call-count assertions instead.
const RUNAWAY_REQUESTS = 25

// As the real translator: the language is the one pinned for the batch, else the current setting.
const translateInTarget = (batch: SubtitlesFragment[], pinnedTarget?: string) =>
  batch.map((cue) => ({
    ...cue,
    translation: failing.has(cue.start) ? undefined : `${pinnedTarget ?? target}:${cue.text}`,
  }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Everything queued on the microtask queue has run once this resolves.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function makeFetcher(cues: SubtitlesFragment[], sourceLanguage: string) {
  return {
    fetch: vi.fn<(...args: any[]) => any>().mockResolvedValue(cues),
    cleanup: vi.fn<(...args: any[]) => any>(),
    // The same track every time: only the viewer's settings move in these scenarios.
    shouldUseSameTrack: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
    getSourceLanguage: vi.fn<() => string>(() => sourceLanguage),
    hasAvailableSubtitles: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
    isPreSegmented: () => true,
  }
}

/** A player with a real scheduler and a real coordinator; only the translator is stubbed. */
function openVideo({ sourceLanguage = "en" }: { sourceLanguage?: string } = {}) {
  const nativeFetcher = makeFetcher(CUES, sourceLanguage)
  const aiFetcher = makeFetcher(CUES, sourceLanguage)
  const video = {
    currentTime: 0.5,
    playbackRate: 1,
    paused: false,
    addEventListener: vi.fn<(...args: any[]) => any>(),
    removeEventListener: vi.fn<(...args: any[]) => any>(),
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
    fetchers: { native: () => nativeFetcher, ai: () => aiFetcher },
  })
  vi.spyOn(adapter as any, "hideNativeSubtitles").mockImplementation(() => {})
  vi.spyOn(adapter as any, "showNativeSubtitles").mockImplementation(() => {})
  const scheduler = new SubtitlesScheduler({ videoElement: video as unknown as HTMLVideoElement })
  scheduler.start()
  scheduler.hide()
  ;(adapter as any).subtitlesScheduler = scheduler
  return { adapter, nativeFetcher, aiFetcher, scheduler, video }
}

type Player = ReturnType<typeof openVideo>

const switchOn = async ({ adapter }: Player) => {
  adapter.toggleSubtitlesManually(true)
  await settle()
}
const switchOff = ({ adapter }: Player) => adapter.toggleSubtitlesManually(false)
const requestAi = async ({ adapter }: Player) => {
  await adapter.requestAiSubtitles()
  await settle()
}

/** What the viewer reads: the translations the scheduler holds for the player right now. */
const shown = () => subtitlesStore.get(translatedTrackAtom).map((cue) => cue.translation)
/** The starts a translate request carried; undefined when that request never happened. */
const batchStarts = (call: number) =>
  (mocks.translateSubtitles.mock.calls[call]?.[0] as SubtitlesFragment[] | undefined)?.map(
    (cue) => cue.start,
  )
const internals = (adapter: UniversalVideoAdapter) =>
  adapter as unknown as {
    translationCoordinator: object | null
    sessionTargetCode: string | undefined
    sessionProcessedFragments: SubtitlesFragment[]
    sessionVideoId: string | null
    startTranslation: () => Promise<boolean>
    clearRuntimeSession: () => void
    resetForNavigation: () => void
  }

describe("subtitle session reuse across target language changes and partial failures", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    target = "kor"
    failing.clear()
    subtitlesStore.set(sourceTrackAtom, [])
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(adPlayingAtom, false)
    subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
    subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
    vi.stubGlobal("document", { title: "Test video", querySelector: () => null })
    mocks.getLocalConfig.mockImplementation(async () => configFor(target))
    mocks.resolveSubtitlesProviderRef.mockReset()
    mocks.translateSubtitles.mockReset()
    mocks.translateSubtitles.mockImplementation(
      (batch: SubtitlesFragment[], _context: unknown, _config: unknown, pinnedTarget?: string) =>
        mocks.translateSubtitles.mock.calls.length > RUNAWAY_REQUESTS
          ? new Promise(() => {})
          : Promise.resolve(translateInTarget(batch, pinnedTarget)),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(sourceTrackAtom, [])
    subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
  })

  describe("a native session", () => {
    it("translates into the new language when the captions are switched on again after the target changed", async () => {
      const player = openVideo()
      await switchOn(player)
      expect(shown()).toEqual(["kor:Hello", "kor:World"])

      switchOff(player)
      target = "jpn"
      await switchOn(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2)
      expect(batchStarts(1)).toEqual([0, 2000])
      // The viewer never sees the first language again: the whole track was rebuilt.
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
    })

    it("resumes without translating again when the target is still the same", async () => {
      const player = openVideo()
      await switchOn(player)
      const coordinator = internals(player.adapter).translationCoordinator

      switchOff(player)
      await switchOn(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
      expect(internals(player.adapter).translationCoordinator).toBe(coordinator)
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
      expect(player.nativeFetcher.fetch).toHaveBeenCalledTimes(1)
    })

    it("follows a second change, and a return to the first language, the same way", async () => {
      const player = openVideo()
      await switchOn(player)

      for (const next of ["jpn", "kor"]) {
        switchOff(player)
        target = next
        await switchOn(player)
        expect(shown()).toEqual([`${next}:Hello`, `${next}:World`])
      }

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(3)
    })

    it("keeps the source cues it already loaded rather than fetching the track again", async () => {
      const player = openVideo()
      await switchOn(player)
      switchOff(player)
      target = "jpn"
      await switchOn(player)

      expect(player.nativeFetcher.fetch).toHaveBeenCalledTimes(1)
      expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["Hello", "World"])
    })

    it("records the language a session was built for and forgets it with the session", async () => {
      const player = openVideo()
      await switchOn(player)
      expect(internals(player.adapter).sessionTargetCode).toBe("kor")

      internals(player.adapter).clearRuntimeSession()
      expect(internals(player.adapter).sessionTargetCode).toBeUndefined()

      await switchOn(player)
      expect(internals(player.adapter).sessionTargetCode).toBe("kor")
      internals(player.adapter).resetForNavigation()
      expect(internals(player.adapter).sessionTargetCode).toBeUndefined()
    })

    it("does not read a session with no recorded language as one for every language", async () => {
      const player = openVideo()
      const coordinator = {
        clearFailed: vi.fn<(...args: any[]) => any>(),
        start: vi.fn<(...args: any[]) => any>(),
        stop: vi.fn<(...args: any[]) => any>(),
      }
      const session = internals(player.adapter)
      session.sessionProcessedFragments = [{ text: "old", start: 0, end: 1000, translation: "?" }]
      session.sessionVideoId = VIDEO_ID
      session.translationCoordinator = coordinator

      await expect(session.startTranslation()).resolves.toBe(true)

      expect(coordinator.start).not.toHaveBeenCalled()
      expect(coordinator.stop).toHaveBeenCalledOnce()
      expect(mocks.translateSubtitles).toHaveBeenCalledOnce()
    })
  })

  describe("an AI session", () => {
    it("translates into the new language when AI subtitles are requested again after the target changed", async () => {
      const player = openVideo()
      await requestAi(player)
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
      expect(subtitlesStore.get(subtitlesSourceAtom)).toBe(SUBTITLES_SOURCE.AI)

      switchOff(player)
      target = "jpn"
      await requestAi(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2)
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
      // The generated captions are not the language-dependent part: no second transcription.
      expect(player.aiFetcher.fetch).toHaveBeenCalledTimes(1)
    })

    it("still resumes an AI session for the same target", async () => {
      const player = openVideo()
      await requestAi(player)
      switchOff(player)
      await requestAi(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
      expect(player.aiFetcher.fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe("a passthrough session", () => {
    it("resumes a track already in the target language without translating or fetching", async () => {
      target = "eng"
      const player = openVideo({ sourceLanguage: "en" })
      await switchOn(player)
      expect(shown()).toEqual(["Hello", "World"])

      switchOff(player)
      await switchOn(player)

      expect(mocks.translateSubtitles).not.toHaveBeenCalled()
      expect(player.nativeFetcher.fetch).toHaveBeenCalledTimes(1)
      expect(shown()).toEqual(["Hello", "World"])
    })

    it("translates once the target is no longer the track's own language", async () => {
      target = "eng"
      const player = openVideo({ sourceLanguage: "en" })
      await switchOn(player)

      switchOff(player)
      target = "kor"
      await switchOn(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
    })
  })

  describe("work still in flight when the target changes", () => {
    it("does not let a response for the old target overwrite the new session", async () => {
      const oldTarget = deferred<SubtitlesFragment[]>()
      mocks.translateSubtitles.mockImplementationOnce(() => oldTarget.promise)
      const player = openVideo()
      await switchOn(player)
      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)

      switchOff(player)
      target = "jpn"
      await switchOn(player)
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])

      // The first request settles last, with the language the viewer already left.
      oldTarget.resolve(CUES.map((cue) => ({ ...cue, translation: `kor:${cue.text}` })))
      await settle()

      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2)
    })

    it("does not let a response for the old target land before the new session has any", async () => {
      const oldTarget = deferred<SubtitlesFragment[]>()
      const newTarget = deferred<SubtitlesFragment[]>()
      mocks.translateSubtitles
        .mockImplementationOnce(() => oldTarget.promise)
        .mockImplementationOnce(() => newTarget.promise)
      const player = openVideo()
      await switchOn(player)

      switchOff(player)
      target = "jpn"
      await switchOn(player)
      oldTarget.resolve(CUES.map((cue) => ({ ...cue, translation: `kor:${cue.text}` })))
      await settle()

      expect(shown()).toEqual([])

      newTarget.resolve(CUES.map((cue) => ({ ...cue, translation: `jpn:${cue.text}` })))
      await settle()
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
    })

    it("lets a start that is still waiting on the provider end once a newer one has taken over", async () => {
      const lateProvider = deferred<undefined>()
      mocks.resolveSubtitlesProviderRef.mockReturnValueOnce(lateProvider.promise)
      const player = openVideo()
      player.adapter.toggleSubtitlesManually(true)
      await vi.waitFor(() => expect(mocks.resolveSubtitlesProviderRef).toHaveBeenCalledOnce())

      switchOff(player)
      target = "jpn"
      await switchOn(player)
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])

      lateProvider.resolve(undefined)
      await settle()

      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
    })

    it("applies nothing from a request that was in flight when the page navigated", async () => {
      const inFlight = deferred<SubtitlesFragment[]>()
      mocks.translateSubtitles.mockImplementationOnce(() => inFlight.promise)
      const player = openVideo()
      await switchOn(player)

      internals(player.adapter).resetForNavigation()
      inFlight.resolve(CUES.map((cue) => ({ ...cue, translation: `kor:${cue.text}` })))
      await settle()

      expect(shown()).toEqual([])
      expect(internals(player.adapter).translationCoordinator).toBeNull()
    })
  })

  describe("a target language that changes while a start is still setting up", () => {
    /** Starts under Korean, then moves the setting to Japanese before the provider has resolved. */
    async function startWhileTheSettingMoves(player: Player) {
      const provider = deferred<undefined>()
      mocks.resolveSubtitlesProviderRef.mockReturnValueOnce(provider.promise)
      player.adapter.toggleSubtitlesManually(true)
      await vi.waitFor(() => expect(mocks.resolveSubtitlesProviderRef).toHaveBeenCalledOnce())
      target = "jpn"
      provider.resolve(undefined)
      await settle()
    }

    it("translates the session into the language it recorded, not the one the setting moved to", async () => {
      const player = openVideo()
      await startWhileTheSettingMoves(player)

      expect(internals(player.adapter).sessionTargetCode).toBe("kor")
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
    })

    it("resumes that session when it is switched on again under the language it recorded", async () => {
      const player = openVideo()
      await startWhileTheSettingMoves(player)

      switchOff(player)
      target = "kor"
      await switchOn(player)

      // Resumed, not rebuilt, and nothing in it is in a language other than the recorded one.
      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
    })

    it("rebuilds it in the new language when it is switched on again under that one", async () => {
      const player = openVideo()
      await startWhileTheSettingMoves(player)

      switchOff(player)
      await switchOn(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2)
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
    })
  })

  describe("a partially failed batch across switch-off and switch-on", () => {
    it("retries only the cue that failed and keeps the one that translated", async () => {
      failing.add(2000)
      const player = openVideo()
      await switchOn(player)

      // The cue that translated is on the player; the failed one is settled and empty (its original
      // shows alone), not a translation that is still on its way.
      expect(shown()).toEqual(["kor:Hello", ""])
      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)

      failing.clear()
      switchOff(player)
      await switchOn(player)

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(2)
      expect(batchStarts(1)).toEqual([2000])
      expect(shown()).toEqual(["kor:Hello", "kor:World"])
    })

    it("does not retry on its own while the captions stay on", async () => {
      failing.add(2000)
      const player = openVideo()
      await switchOn(player)

      for (let tick = 0; tick < 4; tick++) {
        player.video.addEventListener.mock.calls
          .filter(([type]) => type === "timeupdate")
          .forEach(([, listener]) => listener())
        await settle()
      }

      expect(mocks.translateSubtitles).toHaveBeenCalledTimes(1)
    })

    it("rebuilds everything, failed cue included, when the target changed in between", async () => {
      failing.add(2000)
      const player = openVideo()
      await switchOn(player)

      failing.clear()
      switchOff(player)
      target = "jpn"
      await switchOn(player)

      expect(batchStarts(1)).toEqual([0, 2000])
      expect(shown()).toEqual(["jpn:Hello", "jpn:World"])
    })
  })
})
