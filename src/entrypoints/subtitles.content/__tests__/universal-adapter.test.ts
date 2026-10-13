import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { SUBTITLES_SOURCE } from "@/utils/constants/subtitles"
import { OverlaySubtitlesError, ToastSubtitlesError } from "@/utils/subtitles/errors"
import {
  adPlayingAtom,
  currentTimeMsAtom,
  nativeSubtitleTranslationBlockedAtom,
  sourceTrackAtom,
  sourceSubtitlesCopyStatusAtom,
  SubtitleCopyPhase,
  subtitlesSidebarOpenAtom,
  subtitlesSourceAtom,
  subtitlesStore,
  translatedTrackAtom,
} from "../atoms"
import { TranslationCoordinator } from "../translation-coordinator"
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
  return {
    ...actual,
    getLocalConfig: mocks.getLocalConfig,
  }
})

vi.mock("@/utils/subtitles/processor/translator", () => ({
  buildSubtitlesSummaryContextHash: mocks.buildSubtitlesSummaryContextHash,
  resolveSubtitlesProviderRef: mocks.resolveSubtitlesProviderRef,
  fetchSubtitlesSummary: mocks.fetchSubtitlesSummary,
  translateSubtitles: mocks.translateSubtitles,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function createAdapter(
  fetchResult: Array<{ text: string; start: number; end: number }>,
  { videoId, embedded }: { videoId?: string | null; embedded?: boolean } = {},
) {
  const subtitlesFetcher = {
    fetch: vi.fn<(...args: any[]) => any>().mockResolvedValue(fetchResult),
    cleanup: vi.fn<(...args: any[]) => any>(),
    shouldUseSameTrack: vi.fn<(...args: any[]) => any>().mockResolvedValue(false),
    getSourceLanguage: vi.fn<() => string>(() => "en"),
    hasAvailableSubtitles: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
  }
  // The id the page currently shows; a test moves it to navigate.
  const video = { id: videoId ?? null }

  const adapter = new UniversalVideoAdapter({
    config: {
      selectors: {
        video: "video",
        playerContainer: ".player",
        controlsBar: ".controls",
        nativeSubtitles: ".native-subtitles",
      },
      events: {},
      embedded,
      ...(videoId === undefined ? {} : { getVideoId: () => video.id }),
    },
    fetchers: {
      native: () => subtitlesFetcher,
    },
  })

  return { adapter, subtitlesFetcher, video }
}

function attachScheduler(adapter: UniversalVideoAdapter, active: boolean, currentTime = 0) {
  const subtitlesScheduler = {
    isActive: vi.fn<(...args: any[]) => any>(() => active),
    reset: vi.fn<(...args: any[]) => any>(),
    stop: vi.fn<(...args: any[]) => any>(),
    start: vi.fn<(...args: any[]) => any>(),
    show: vi.fn<(...args: any[]) => any>(),
    setState: vi.fn<(...args: any[]) => any>(),
    supplementSubtitles: vi.fn<(...args: any[]) => any>(),
    reconcileTranslatedCuesAfterRecut: vi.fn<(...args: any[]) => any>(),
    resyncFromVideo: vi.fn<(...args: any[]) => any>(),
    hide: vi.fn<(...args: any[]) => any>(),
    getVideoElement: vi.fn<(...args: any[]) => any>(() => ({ currentTime })),
    getState: vi.fn<(...args: any[]) => any>(() => "idle"),
  }

  ;(adapter as any).subtitlesScheduler = subtitlesScheduler
  return subtitlesScheduler
}

describe("universalVideoAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subtitlesStore.set(sourceTrackAtom, [])
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(currentTimeMsAtom, 0)
    subtitlesStore.set(subtitlesSidebarOpenAtom, false)
    vi.stubGlobal("document", {
      title: "Test video",
      querySelector: vi.fn<(...args: any[]) => any>(() => null),
    })
    mocks.getLocalConfig.mockResolvedValue({
      language: {},
      providersConfig: [],
      videoSubtitles: {
        aiSegmentation: false,
        providerId: null,
      },
    })
  })

  afterEach(() => {
    subtitlesStore.set(adPlayingAtom, false)
    vi.unstubAllGlobals()
  })

  it("tracks ad state and resyncs subtitles when an ad ends", () => {
    const { adapter } = createAdapter([])
    const scheduler = attachScheduler(adapter, true)
    const requestTick = vi.fn<(...args: any[]) => any>()
    ;(adapter as any).translationCoordinator = { requestTick }

    let playing = true
    const player = {} as HTMLElement
    vi.stubGlobal("document", {
      title: "Test video",
      querySelector: vi.fn<(selector: string) => Element | null>(() => player),
    })
    ;(adapter as any).config.isAdPlaying = vi.fn<() => boolean>(() => playing)

    let observerCallback!: MutationCallback
    const observe = vi.fn<(...args: any[]) => any>()
    const disconnect = vi.fn<(...args: any[]) => any>()
    class FakeMutationObserver {
      constructor(callback: MutationCallback) {
        observerCallback = callback
      }

      observe = observe
      disconnect = disconnect
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver)

    ;(adapter as any).setupAdObserver()

    expect(subtitlesStore.get(adPlayingAtom)).toBe(true)
    expect(observe).toHaveBeenCalledWith(player, {
      attributes: true,
      attributeFilter: ["class"],
    })

    playing = false
    observerCallback([], {} as MutationObserver)

    expect(subtitlesStore.get(adPlayingAtom)).toBe(false)
    expect(scheduler.resyncFromVideo).toHaveBeenCalledTimes(1)
    expect(requestTick).toHaveBeenCalledTimes(1)

    playing = true
    observerCallback([], {} as MutationObserver)
    ;(adapter as any).teardownAdObserver()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(subtitlesStore.get(adPlayingAtom)).toBe(false)
  })

  it("keeps raw source subtitles and rebuilds processed source subtitles", async () => {
    const subtitles = [
      { text: "I agree.", start: 0, end: 500 },
      { text: "It is true.", start: 500, end: 1000 },
      { text: "We can do this.", start: 1000, end: 1500 },
      { text: "Let's ship now.", start: 1500, end: 2000 },
    ]
    const { adapter } = createAdapter(subtitles)

    await (adapter as any).getOrLoadSourceSubtitles()

    expect((adapter as any).sourceSubtitles).toEqual(subtitles)
    expect((adapter as any).sourceProcessedSubtitles).toEqual([
      {
        text: "I agree. It is true. We can do this. Let's ship now.",
        start: 0,
        end: 2000,
      },
    ])
  })

  it("reloads subtitles when the source track changes while translation is enabled", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "hello", start: 0, end: 500 }])

    const subtitlesScheduler = attachScheduler(adapter, true)

    const clearRuntimeSessionSpy = vi.spyOn(adapter as any, "clearRuntimeSession")
    const clearSourceCacheSpy = vi.spyOn(adapter as any, "clearSourceCache")
    const startTranslationSpy = vi
      .spyOn(adapter as any, "startTranslation")
      .mockResolvedValue(undefined)

    await adapter.handleSourceTrackChanged()

    expect(subtitlesFetcher.shouldUseSameTrack).toHaveBeenCalledTimes(1)
    expect(clearRuntimeSessionSpy).toHaveBeenCalledTimes(1)
    expect(clearSourceCacheSpy).toHaveBeenCalledTimes(1)
    expect(subtitlesFetcher.cleanup).toHaveBeenCalledTimes(1)
    expect(subtitlesScheduler.reset).toHaveBeenCalledTimes(1)
    expect(subtitlesScheduler.setState).toHaveBeenCalledWith("loading")
    expect(startTranslationSpy).toHaveBeenCalledTimes(1)
  })

  it("ignores source track changes when translation is disabled", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "hello", start: 0, end: 500 }])

    attachScheduler(adapter, false)
    const startTranslationSpy = vi
      .spyOn(adapter as any, "startTranslation")
      .mockResolvedValue(undefined)

    await adapter.handleSourceTrackChanged()

    expect(subtitlesFetcher.shouldUseSameTrack).not.toHaveBeenCalled()
    expect(startTranslationSpy).not.toHaveBeenCalled()
  })

  it("does not reload subtitles when the selected track is unchanged", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "hello", start: 0, end: 500 }])

    const subtitlesScheduler = attachScheduler(adapter, true)
    vi.mocked(subtitlesFetcher.shouldUseSameTrack).mockResolvedValue(true)

    const startTranslationSpy = vi
      .spyOn(adapter as any, "startTranslation")
      .mockResolvedValue(undefined)

    await adapter.handleSourceTrackChanged()

    expect(subtitlesFetcher.shouldUseSameTrack).toHaveBeenCalledTimes(1)
    expect(subtitlesFetcher.cleanup).not.toHaveBeenCalled()
    expect(subtitlesScheduler.reset).not.toHaveBeenCalled()
    expect(subtitlesScheduler.setState).not.toHaveBeenCalled()
    expect(startTranslationSpy).not.toHaveBeenCalled()
  })

  it("delegates translated subtitle copy to the exporter", async () => {
    const { adapter } = createAdapter([])
    const downloader = {
      copy: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      dispose: vi.fn<(...args: any[]) => any>(),
    }
    ;(adapter as any).translatedSubtitlesExporter = downloader

    await adapter.copyTranslatedSubtitles()

    expect(downloader.copy).toHaveBeenCalledTimes(1)
  })

  it("returns false from startTranslation when the fetcher fails", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "x", start: 0, end: 1 }])
    subtitlesFetcher.fetch.mockRejectedValue(new Error("boom"))
    attachScheduler(adapter, true)

    await expect((adapter as any).startTranslation()).resolves.toBe(false)
  })

  // Netflix answers the track check with a round trip to the page, which can take seconds.
  it("starts a fresh load without waiting on the fetcher's track check", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "x", start: 0, end: 1 }])
    subtitlesFetcher.shouldUseSameTrack.mockReturnValue(new Promise(() => {}))
    subtitlesFetcher.fetch.mockRejectedValue(new Error("boom"))
    attachScheduler(adapter, true)

    void (adapter as any).startTranslation()

    await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledTimes(1))
  })

  // The loading state has no auto-hide of its own, so a wall that only raises a
  // toast used to leave "Loading AI subtitles" pinned to the player forever.
  it("clears the loading state and anchors the AI wall to its trigger", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    const action = { label: "action.upgrade", url: "https://readfrog.app/pricing" }
    ;(adapter as any).source = SUBTITLES_SOURCE.AI
    subtitlesFetcher.fetch.mockRejectedValue(
      new ToastSubtitlesError("subtitles.errors.aiSubscriptionRequired", action),
    )
    const scheduler = attachScheduler(adapter, true)

    await expect((adapter as any).startTranslation()).resolves.toBe(false)

    expect(scheduler.setState).toHaveBeenLastCalledWith("idle")
    expect(mocks.showAiSubtitlesWallToast).toHaveBeenCalledWith(
      "subtitles.errors.aiSubscriptionRequired",
      action,
    )
  })

  it("raises a toast without an action when the error carries none", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    ;(adapter as any).source = SUBTITLES_SOURCE.AI
    subtitlesFetcher.fetch.mockRejectedValue(
      new ToastSubtitlesError("subtitles.errors.aiVideoTooLong"),
    )
    attachScheduler(adapter, true)

    await expect((adapter as any).startTranslation()).resolves.toBe(false)

    expect(mocks.showAiSubtitlesWallToast).toHaveBeenCalledWith(
      "subtitles.errors.aiVideoTooLong",
      undefined,
    )
  })

  // Only the AI request has a control on screen to point at. Anything else has
  // nothing on the player that would explain a toast pinned to that button.
  it("leaves a non-AI toast error docked in the page corner", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    subtitlesFetcher.fetch.mockRejectedValue(
      new ToastSubtitlesError("subtitles.errors.noSubtitlesFound"),
    )
    attachScheduler(adapter, true)

    await expect((adapter as any).startTranslation()).resolves.toBe(false)

    expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledWith(
      "subtitles.errors.noSubtitlesFound",
      undefined,
    )
    expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
  })

  // A superseded switch or a navigation rejects with DOMException("Aborted"),
  // whose message is not user copy and must never be painted on the player.
  it("stays silent when the run was aborted", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    subtitlesFetcher.fetch.mockRejectedValue(new DOMException("Aborted", "AbortError"))
    const scheduler = attachScheduler(adapter, true)

    await expect((adapter as any).startTranslation()).resolves.toBe(false)

    expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
    expect(scheduler.setState).not.toHaveBeenCalledWith("error", expect.anything())
  })

  // The overlay path already replaces the loading state and auto-hides itself;
  // resetting it here would wipe the message the user needs to read.
  it("keeps rendering overlay errors on the player instead of toasting them", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    subtitlesFetcher.fetch.mockRejectedValue(
      new OverlaySubtitlesError("subtitles.errors.aiRequestFailed"),
    )
    const scheduler = attachScheduler(adapter, true)

    await expect((adapter as any).startTranslation()).resolves.toBe(false)

    expect(scheduler.setState).toHaveBeenLastCalledWith("error", {
      message: "subtitles.errors.aiRequestFailed",
    })
    expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
  })

  it("refuses AI subtitles for live content with a toast before switching fetchers", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    ;(adapter as any).config.isLiveContent = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const switchSubtitlesFetcher = vi
      .spyOn(adapter as any, "switchSubtitlesFetcher")
      .mockResolvedValue(undefined)

    await adapter.requestAiSubtitles()

    expect(mocks.showAiSubtitlesWallToast).toHaveBeenCalledWith(
      "subtitles.errors.aiLiveReplayUnsupported",
    )
    expect(switchSubtitlesFetcher).not.toHaveBeenCalled()
    expect(subtitlesFetcher.cleanup).not.toHaveBeenCalled()
  })

  it("switches to the AI fetcher when the video is not live content", async () => {
    const { adapter } = createAdapter([])
    ;(adapter as any).config.isLiveContent = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false)
    const switchSubtitlesFetcher = vi
      .spyOn(adapter as any, "switchSubtitlesFetcher")
      .mockResolvedValue(undefined)

    await adapter.requestAiSubtitles()

    expect(switchSubtitlesFetcher).toHaveBeenCalledWith(SUBTITLES_SOURCE.AI)
    expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
  })

  it("switches to the AI fetcher when the platform cannot tell live content apart", async () => {
    const { adapter } = createAdapter([])
    const switchSubtitlesFetcher = vi
      .spyOn(adapter as any, "switchSubtitlesFetcher")
      .mockResolvedValue(undefined)

    await adapter.requestAiSubtitles()

    expect(switchSubtitlesFetcher).toHaveBeenCalledWith(SUBTITLES_SOURCE.AI)
    expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
  })

  it("reverts the source back to native so a failed AI switch can be retried", () => {
    const { adapter, subtitlesFetcher } = createAdapter([])
    const aiFetcher = { cleanup: vi.fn<(...args: any[]) => any>() }
    ;(adapter as any).fetcher = aiFetcher
    ;(adapter as any).source = SUBTITLES_SOURCE.AI
    subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.AI)

    ;(adapter as any).revertToNativeSource()

    expect(aiFetcher.cleanup).toHaveBeenCalledTimes(1)
    expect((adapter as any).source).toBe(SUBTITLES_SOURCE.NATIVE)
    expect(subtitlesStore.get(subtitlesSourceAtom)).toBe(SUBTITLES_SOURCE.NATIVE)
    expect((adapter as any).fetcher).toBe(subtitlesFetcher)
  })

  it("does not revert to native when a newer switch supersedes the in-flight one", async () => {
    const { adapter } = createAdapter([])
    const aiFetcher = { cleanup: vi.fn<(...args: any[]) => any>() }
    ;(adapter as any).fetchers = {
      native: (adapter as any).fetchers.native,
      ai: () => aiFetcher,
    }
    const scheduler = attachScheduler(adapter, true)
    ;(scheduler as any).start = vi.fn<(...args: any[]) => any>()
    ;(scheduler as any).show = vi.fn<(...args: any[]) => any>()
    vi.spyOn(adapter as any, "hideNativeSubtitles").mockImplementation(() => {})
    vi.spyOn(adapter as any, "showNativeSubtitles").mockImplementation(() => {})

    let resolveStart: (value: boolean) => void = () => {}
    vi.spyOn(adapter as any, "startTranslation").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStart = resolve
        }),
    )
    const revertSpy = vi.spyOn(adapter as any, "revertToNativeSource").mockImplementation(() => {})

    const pending = (adapter as any).switchSubtitlesFetcher(SUBTITLES_SOURCE.AI)
    ;(adapter as any).resetForNavigation()
    resolveStart(false)
    await pending

    expect(revertSpy).not.toHaveBeenCalled()
  })

  it("disposes translated subtitle download state when navigation starts", () => {
    const { adapter } = createAdapter([])
    const downloader = {
      copy: vi.fn<(...args: any[]) => any>(),
      dispose: vi.fn<(...args: any[]) => any>(),
    }
    ;(adapter as any).translatedSubtitlesExporter = downloader
    attachScheduler(adapter, false)

    ;(adapter as any).clearVisibleStateForNavigation()

    expect(downloader.dispose).toHaveBeenCalledTimes(1)
  })

  it("publishes source track without seeding untranslated cues into the scheduler", async () => {
    const subtitles = [
      { text: "I agree.", start: 0, end: 500 },
      { text: "It is true.", start: 500, end: 1000 },
    ]
    const { adapter } = createAdapter(subtitles)
    const subtitlesScheduler = attachScheduler(adapter, true)

    mocks.getLocalConfig.mockResolvedValue({
      language: { targetCode: "zh-CN" },
      providersConfig: [],
      videoSubtitles: {
        aiSegmentation: false,
        providerId: null,
      },
    })

    await (adapter as any).getOrLoadSourceSubtitles()
    ;(adapter as any).sessionSubtitles = (adapter as any).sourceSubtitles

    const startSpy = vi
      .spyOn(TranslationCoordinator.prototype, "start")
      .mockImplementation(() => undefined)

    await (adapter as any).processTranslatedSubtitles()

    const sourceTrack = subtitlesStore.get(sourceTrackAtom)
    expect(sourceTrack.length).toBeGreaterThan(0)
    expect(sourceTrack.every((f) => f.translation === undefined)).toBe(true)

    // Scheduler must not receive untranslated seeds; only coordinator will push translations later.
    expect(subtitlesScheduler.supplementSubtitles).not.toHaveBeenCalled()
    expect(startSpy).toHaveBeenCalled()

    startSpy.mockRestore()
  })

  it("publishes the source track without waiting on the provider resolve", async () => {
    const { adapter } = createAdapter([{ text: "hello", start: 0, end: 1000 }])
    attachScheduler(adapter, true)

    await (adapter as any).getOrLoadSourceSubtitles()
    ;(adapter as any).sessionSubtitles = (adapter as any).sourceSubtitles

    const startSpy = vi
      .spyOn(TranslationCoordinator.prototype, "start")
      .mockImplementation(() => undefined)

    // A hosted resolve reaches the network, and backgroundFetch carries no
    // timeout — so a dead connection never settles this. The original captions
    // need nothing from it, and this is the only path that puts captions on
    // screen for the translated flow: ordering it after the resolve left the
    // player in "loading" showing nothing at all.
    // Once, not permanently: clearAllMocks between tests drops calls but keeps
    // implementations, so a never-settling mockReturnValue would hang the next
    // test instead of this one.
    mocks.resolveSubtitlesProviderRef.mockReturnValueOnce(new Promise(() => {}))

    // A config is passed so the provider resolve runs here and consumes the value queued above.
    void (adapter as any).processTranslatedSubtitles({ videoSubtitles: { aiSegmentation: false } })
    await Promise.resolve()
    await Promise.resolve()

    expect(subtitlesStore.get(sourceTrackAtom).length).toBeGreaterThan(0)

    startSpy.mockRestore()
  })

  it("syncs currentTimeMsAtom from the video when publishing the source track", async () => {
    const { adapter } = createAdapter([{ text: "hello", start: 0, end: 1000 }])
    attachScheduler(adapter, true, 42.5)

    await (adapter as any).getOrLoadSourceSubtitles()
    ;(adapter as any).sessionSubtitles = (adapter as any).sourceSubtitles

    const startSpy = vi
      .spyOn(TranslationCoordinator.prototype, "start")
      .mockImplementation(() => undefined)

    await (adapter as any).processTranslatedSubtitles()

    expect(subtitlesStore.get(currentTimeMsAtom)).toBe(42_500)

    startSpy.mockRestore()
  })

  it("drops stale translations when an inactive track is refreshed", async () => {
    const { adapter } = createAdapter([{ text: "hello", start: 0, end: 500 }])
    attachScheduler(adapter, false)
    subtitlesStore.set(sourceTrackAtom, [{ text: "old", start: 0, end: 500 }])
    subtitlesStore.set(translatedTrackAtom, [
      { text: "old", start: 0, end: 500, translation: "旧" },
    ])

    await adapter.handleSourceTrackChanged()

    expect(subtitlesStore.get(translatedTrackAtom)).toEqual([])
  })

  it("resets the hidden session when an inactive track is refreshed", async () => {
    const { adapter } = createAdapter([{ text: "hello", start: 0, end: 500 }])
    const subtitlesScheduler = attachScheduler(adapter, false)
    subtitlesStore.set(sourceTrackAtom, [{ text: "old", start: 0, end: 500 }])
    ;(adapter as any).sessionProcessedFragments = [
      { text: "old", start: 0, end: 500, translation: "旧" },
    ]
    ;(adapter as any).sessionVideoId = ""

    await adapter.handleSourceTrackChanged()

    // Otherwise re-enabling captions would resume the old cues against the new track.
    expect((adapter as any).sessionProcessedFragments).toEqual([])
    expect((adapter as any).sessionVideoId).toBeNull()
    expect(subtitlesScheduler.reset).toHaveBeenCalledTimes(1)
    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["hello"])
  })

  it("refreshes the track while the transcript's first load is still in flight", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "hello", start: 0, end: 500 }])
    attachScheduler(adapter, false)
    let resolveFirstFetch!: (cues: unknown) => void
    subtitlesFetcher.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirstFetch = resolve
      }),
    )

    const firstLoad = adapter.ensureSourceTrackPublished()
    await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledTimes(1))

    await adapter.handleSourceTrackChanged()

    // An empty atom used to read as "transcript not in use", dropping the change.
    expect(subtitlesFetcher.cleanup).toHaveBeenCalledTimes(1)
    expect(subtitlesFetcher.fetch).toHaveBeenCalledTimes(2)

    resolveFirstFetch([{ text: "old", start: 0, end: 500 }])
    await firstLoad.catch(() => undefined)

    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["hello"])
  })

  it("reports a failed transcript refresh and retains intent to publish on a later retry", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "new", start: 0, end: 500 }])
    attachScheduler(adapter, false)
    subtitlesStore.set(sourceTrackAtom, [{ text: "old", start: 0, end: 500 }])
    subtitlesFetcher.fetch.mockRejectedValueOnce(
      new OverlaySubtitlesError("Track temporarily unavailable"),
    )
    await expect(adapter.handleSourceTrackChanged()).resolves.toBeUndefined()
    expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledWith("Track temporarily unavailable")
    expect(subtitlesStore.get(sourceTrackAtom)).toEqual([])
    await expect(adapter.handleSourceTrackChanged()).resolves.toBeUndefined()
    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["new"])
  })

  it("cancels retained transcript refresh intent immediately when navigation tears down the view", async () => {
    const { adapter, subtitlesFetcher } = createAdapter([{ text: "new", start: 0, end: 500 }])
    attachScheduler(adapter, false)
    subtitlesStore.set(sourceTrackAtom, [{ text: "old", start: 0, end: 500 }])
    subtitlesFetcher.fetch.mockRejectedValueOnce(
      new OverlaySubtitlesError("Track temporarily unavailable"),
    )
    await adapter.handleSourceTrackChanged()
    ;(adapter as any).clearVisibleStateForNavigation()
    subtitlesFetcher.fetch.mockClear()
    await adapter.handleSourceTrackChanged()
    expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
    expect(subtitlesStore.get(sourceTrackAtom)).toEqual([])
  })

  it("replaceSourceTrackWindow drops cues that overlap the window by interval", () => {
    const { adapter } = createAdapter([])
    attachScheduler(adapter, true)

    // Spans into the replace window even though its start is before windowStart.
    subtitlesStore.set(sourceTrackAtom, [
      { text: "overlap", start: 0, end: 1500 },
      { text: "after", start: 2000, end: 3000 },
    ])

    ;(adapter as any).replaceSourceTrackWindow(1000, 2000, [
      { text: "recut", start: 1000, end: 2000 },
    ])

    expect(subtitlesStore.get(sourceTrackAtom)).toEqual([
      { text: "recut", start: 1000, end: 2000 },
      { text: "after", start: 2000, end: 3000 },
    ])
  })
  it("prepares source captions before copying and clears the prepared text on track change", async () => {
    const writeText = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const { adapter, subtitlesFetcher } = createAdapter([
      { text: "Hello at 12:30, bring 2 tickets.", start: 0, end: 1000 },
    ])
    await adapter.copySourceSubtitles()
    expect(writeText).not.toHaveBeenCalled()
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Ready)
    subtitlesFetcher.shouldUseSameTrack.mockResolvedValueOnce(true)
    await adapter.handleSourceTrackChanged()
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Ready)
    const copy = adapter.copySourceSubtitles()
    expect(writeText).toHaveBeenCalledWith("Hello at 12:30, bring 2 tickets.")
    await copy
    expect(subtitlesFetcher.fetch).toHaveBeenCalledTimes(1)
    await adapter.handleSourceTrackChanged()
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Idle)
  })

  describe("starting without a chosen subtitles provider", () => {
    const PROVIDER_ID = "subtitles-provider"
    const FRAGMENTS = [{ text: "Hello there.", start: 0, end: 1000 }]
    const SETTINGS_URL = "/options.html#/api-providers?section=feature-provider-videoSubtitles"

    function configWith({
      providerId = PROVIDER_ID,
      enabled = true,
      targetCode = "cmn",
      displayMode = "bilingual",
    } = {}) {
      return {
        language: { targetCode },
        providersConfig: [
          { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled },
        ],
        videoSubtitles: { aiSegmentation: false, providerId, style: { displayMode } },
      }
    }

    const stubCoordinatorStart = () =>
      vi.spyOn(TranslationCoordinator.prototype, "start").mockImplementation(() => undefined)

    // A running session on the current video, as an earlier start leaves it behind.
    function resumableSession(adapter: UniversalVideoAdapter, withCoordinator: boolean) {
      const coordinator = {
        clearFailed: vi.fn<(...args: any[]) => any>(),
        start: vi.fn<(...args: any[]) => any>(),
        stop: vi.fn<(...args: any[]) => any>(),
      }
      ;(adapter as any).sessionProcessedFragments = [
        { text: "old", start: 0, end: 1000, translation: "old translation" },
      ]
      ;(adapter as any).sessionVideoId = ""
      ;(adapter as any).translationCoordinator = withCoordinator ? coordinator : null
      return coordinator
    }

    beforeEach(() => {
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
      // A value queued with mockReturnValueOnce survives clearAllMocks; start each test without one.
      mocks.resolveSubtitlesProviderRef.mockReset()
    })

    afterEach(() => {
      ;(TranslationCoordinator.prototype.start as { mockRestore?: () => void }).mockRestore?.()
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
    })

    it("translates as before when the chosen provider resolves", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(configWith())
      const { adapter } = createAdapter(FRAGMENTS)
      attachScheduler(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(startSpy).toHaveBeenCalledOnce()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
    })

    it.each<[string, Parameters<typeof configWith>[0]]>([
      ["unassigned", { providerId: "unconfigured" }],
      ["deleted", { providerId: "gone" }],
      ["disabled", { enabled: false }],
    ])(
      "keeps the original captions and offers settings when the provider is %s",
      async (_case, overrides) => {
        const startSpy = stubCoordinatorStart()
        mocks.getLocalConfig.mockResolvedValue(configWith(overrides))
        const { adapter } = createAdapter(FRAGMENTS)
        const scheduler = attachScheduler(adapter, true)

        await expect((adapter as any).startTranslation()).resolves.toBe(false)

        // Nothing is requested, nothing is hidden, and the loading state is cleared.
        expect(startSpy).not.toHaveBeenCalled()
        expect(mocks.translateSubtitles).not.toHaveBeenCalled()
        expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
        expect(scheduler.supplementSubtitles).not.toHaveBeenCalled()
        expect(scheduler.hide).not.toHaveBeenCalled()
        expect(scheduler.setState).toHaveBeenLastCalledWith("idle")
        // The originals are published for the overlay and the transcript, and the cues are
        // marked as not waiting for a translation.
        const sourceTrack = subtitlesStore.get(sourceTrackAtom)
        expect(sourceTrack.length).toBeGreaterThan(0)
        expect(sourceTrack.every((cue) => cue.translation === undefined)).toBe(true)
        expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
        expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledExactlyOnceWith(
          "providerRequired.message",
          {
            label: "providerRequired.openSettings",
            url: expect.stringContaining(SETTINGS_URL),
          },
        )
        expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
      },
    )

    it.each<[string, Parameters<typeof configWith>[0]]>([
      ["bilingual", { providerId: "unconfigured", targetCode: "eng", displayMode: "bilingual" }],
      [
        "original-only",
        { providerId: "unconfigured", targetCode: "eng", displayMode: "originalOnly" },
      ],
    ])(
      "still passes a track already in the target language through as its own translation (%s)",
      async (_case, overrides) => {
        const startSpy = stubCoordinatorStart()
        mocks.getLocalConfig.mockResolvedValue(configWith(overrides))
        const { adapter } = createAdapter(FRAGMENTS)
        const scheduler = attachScheduler(adapter, true)

        await expect((adapter as any).startTranslation()).resolves.toBe(true)

        expect(scheduler.supplementSubtitles).toHaveBeenCalledOnce()
        const [shown] = scheduler.supplementSubtitles.mock.calls[0]!
        expect(
          shown.every(
            (cue: { text: string; translation?: string }) => cue.translation === cue.text,
          ),
        ).toBe(true)
        expect(startSpy).not.toHaveBeenCalled()
        expect(mocks.translateSubtitles).not.toHaveBeenCalled()
        expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
        expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
      },
    )

    it("shows the originals as they are, with no fake translation, when only originals are wanted and no provider is chosen", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(
        configWith({ providerId: "unconfigured", displayMode: "originalOnly" }),
      )
      const { adapter } = createAdapter(FRAGMENTS)
      const scheduler = attachScheduler(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      // A source-only success: the cues are shown untranslated and nothing waits for a translation.
      expect(scheduler.supplementSubtitles).not.toHaveBeenCalled()
      expect(scheduler.setState).toHaveBeenLastCalledWith("idle")
      expect(scheduler.hide).not.toHaveBeenCalled()
      const sourceTrack = subtitlesStore.get(sourceTrackAtom)
      expect(sourceTrack.length).toBeGreaterThan(0)
      expect(sourceTrack.every((cue) => cue.translation === undefined)).toBe(true)
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
      expect(startSpy).not.toHaveBeenCalled()
      expect(mocks.translateSubtitles).not.toHaveBeenCalled()
      expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      // Never kept as a finished session, so it cannot be resumed as one.
      expect((adapter as any).sessionProcessedFragments).toEqual([])
      expect((adapter as any).translationCoordinator).toBeNull()
    })

    it("translates from a fresh session once a provider is chosen after a source-only start", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(
        configWith({ providerId: "unconfigured", displayMode: "originalOnly" }),
      )
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      // The track is the same, so a finished passthrough session would be resumed if one were kept.
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      const scheduler = attachScheduler(adapter, true)
      await expect((adapter as any).startTranslation()).resolves.toBe(true)
      expect(startSpy).not.toHaveBeenCalled()

      mocks.getLocalConfig.mockResolvedValue(configWith({ displayMode: "originalOnly" }))
      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(startSpy).toHaveBeenCalledOnce()
      expect(scheduler.supplementSubtitles).not.toHaveBeenCalled()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
    })

    it("does not resume an old coordinator when only originals are wanted and the provider is gone", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(
        configWith({ providerId: "gone", displayMode: "originalOnly" }),
      )
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      const scheduler = attachScheduler(adapter, true)
      const coordinator = resumableSession(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(coordinator.start).not.toHaveBeenCalled()
      expect(coordinator.stop).toHaveBeenCalledOnce()
      expect(startSpy).not.toHaveBeenCalled()
      expect(scheduler.supplementSubtitles).not.toHaveBeenCalled()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    })

    it("lowers the refusal flag before its first await, so a second trigger finds it down", async () => {
      mocks.getLocalConfig.mockResolvedValue(
        configWith({ providerId: "unconfigured", displayMode: "originalOnly" }),
      )
      const { adapter } = createAdapter(FRAGMENTS)
      attachScheduler(adapter, true)
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, true)

      const start = (adapter as any).startTranslation()

      // Synchronously: nothing has been awaited yet, not even the config read.
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
      await start
    })

    it("starts one coordinator over cues a source-only start left untranslated", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(
        configWith({ providerId: "unconfigured", displayMode: "originalOnly" }),
      )
      const { adapter } = createAdapter(FRAGMENTS)
      attachScheduler(adapter, true)
      await (adapter as any).startTranslation()
      expect(
        subtitlesStore.get(sourceTrackAtom).every((cue) => cue.translation === undefined),
      ).toBe(true)

      // The reader leaves original-only with a provider chosen: the same start runs again.
      mocks.getLocalConfig.mockResolvedValue(configWith({ displayMode: "bilingual" }))
      await (adapter as any).startTranslation()

      expect(startSpy).toHaveBeenCalledOnce()
      expect((adapter as any).translationCoordinator).not.toBeNull()
      // What the coordinator works through: every cue still waiting for its translation.
      const eligible = (adapter as any).sessionProcessedFragments
      expect(eligible.length).toBeGreaterThan(0)
      expect(eligible.every((cue: { translation?: string }) => cue.translation === undefined)).toBe(
        true,
      )
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
    })

    it("still translates in original-only mode when a provider is chosen", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(configWith({ displayMode: "originalOnly" }))
      const { adapter } = createAdapter(FRAGMENTS)
      const scheduler = attachScheduler(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(startSpy).toHaveBeenCalledOnce()
      expect(scheduler.supplementSubtitles).not.toHaveBeenCalled()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
    })

    it("resumes a translated session on the same track while the provider holds", async () => {
      mocks.getLocalConfig.mockResolvedValue(configWith())
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      attachScheduler(adapter, true)
      const coordinator = resumableSession(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(coordinator.clearFailed).toHaveBeenCalledOnce()
      expect(coordinator.start).toHaveBeenCalledOnce()
      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
    })

    it("does not restart the old coordinator once the provider is gone, and recovers when one is set", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(configWith({ providerId: "gone" }))
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      attachScheduler(adapter, true)
      const coordinator = resumableSession(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(false)

      expect(coordinator.start).not.toHaveBeenCalled()
      expect(coordinator.stop).toHaveBeenCalledOnce()
      expect(startSpy).not.toHaveBeenCalled()
      expect(subtitlesStore.get(sourceTrackAtom).length).toBeGreaterThan(0)
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
      expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledOnce()

      // Choosing a provider and switching on again translates from a fresh session.
      mocks.getLocalConfig.mockResolvedValue(configWith())
      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(startSpy).toHaveBeenCalledOnce()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
      expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledOnce()
    })

    it("resumes a passthrough session without fetching again while it still needs no translation", async () => {
      mocks.getLocalConfig.mockResolvedValue(
        configWith({ providerId: "unconfigured", targetCode: "eng" }),
      )
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      const scheduler = attachScheduler(adapter, true)
      resumableSession(adapter, false)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(scheduler.supplementSubtitles).toHaveBeenCalledWith(
        (adapter as any).sessionProcessedFragments,
      )
      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
    })

    it("starts a fresh translation when a passthrough session now needs one and a provider is chosen", async () => {
      const startSpy = stubCoordinatorStart()
      mocks.getLocalConfig.mockResolvedValue(configWith({ targetCode: "cmn" }))
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      attachScheduler(adapter, true)
      resumableSession(adapter, false)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
      expect(startSpy).toHaveBeenCalledOnce()
    })

    it("leaves an AI session's resume as it was, provider or not", async () => {
      mocks.getLocalConfig.mockResolvedValue(configWith({ providerId: "unconfigured" }))
      const { adapter, subtitlesFetcher } = createAdapter(FRAGMENTS)
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      attachScheduler(adapter, true)
      ;(adapter as any).source = SUBTITLES_SOURCE.AI
      const coordinator = resumableSession(adapter, true)

      await expect((adapter as any).startTranslation()).resolves.toBe(true)

      expect(coordinator.start).toHaveBeenCalledOnce()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      expect(mocks.showAiSubtitlesWallToast).not.toHaveBeenCalled()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
    })

    it("switches off without a provider and without asking for one", () => {
      mocks.getLocalConfig.mockResolvedValue(configWith({ providerId: "unconfigured" }))
      const { adapter } = createAdapter(FRAGMENTS)
      const scheduler = attachScheduler(adapter, true)
      const coordinator = resumableSession(adapter, true)

      adapter.toggleSubtitlesManually(false)

      expect(scheduler.hide).toHaveBeenCalledOnce()
      expect(coordinator.stop).toHaveBeenCalledOnce()
      expect(mocks.getLocalConfig).not.toHaveBeenCalled()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    })

    it("prepares the original captions for copying without a provider", async () => {
      mocks.getLocalConfig.mockResolvedValue(configWith({ providerId: "unconfigured" }))
      const { adapter } = createAdapter(FRAGMENTS)

      await adapter.copySourceSubtitles()

      expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Ready)
      expect(mocks.translateSubtitles).not.toHaveBeenCalled()
      expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    })
  })

  describe("translating foreign-language videos by itself", () => {
    const PROVIDER_ID = "auto-start-provider"
    const FRAGMENTS = [{ text: "Hello there.", start: 0, end: 1000 }]
    const SETTINGS_URL = "/options.html#/api-providers?section=feature-provider-videoSubtitles"
    const AUTO_START_ARGS = [
      SUBTITLES_SOURCE.NATIVE,
      expect.objectContaining({
        feature: ANALYTICS_FEATURE.VIDEO_SUBTITLES,
        surface: ANALYTICS_SURFACE.VIDEO_SUBTITLES_AUTO,
      }),
    ]

    const spies: Array<{ mockRestore: () => void }> = []
    const track = <T extends { mockRestore: () => void }>(spy: T) => {
      spies.push(spy)
      return spy
    }
    // Everything queued on the microtask and timer queues has run once this resolves.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    function configFor({
      autoStart = true,
      targetCode = "kor",
      withProvider = true,
      displayMode = "bilingual",
    } = {}) {
      return {
        language: { targetCode },
        providersConfig: withProvider
          ? [{ ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true }]
          : [],
        videoSubtitles: {
          autoStart,
          aiSegmentation: false,
          providerId: PROVIDER_ID,
          style: { displayMode },
        },
      }
    }

    // A video page with its player mounted but nothing switched on, as `initialize` leaves it.
    function openVideo({
      language = "ja",
      videoId = "A",
      embedded,
    }: { language?: string; videoId?: string | null; embedded?: boolean } = {}) {
      const { adapter, subtitlesFetcher, video } = createAdapter(FRAGMENTS, { videoId, embedded })
      subtitlesFetcher.getSourceLanguage.mockReturnValue(language)
      // The same track again is the same track, so a start reuses what the attempt fetched.
      subtitlesFetcher.shouldUseSameTrack.mockResolvedValue(true)
      track(vi.spyOn(adapter as any, "hideNativeSubtitles")).mockImplementation(() => {})
      track(vi.spyOn(adapter as any, "showNativeSubtitles")).mockImplementation(() => {})
      return { adapter, subtitlesFetcher, video, scheduler: attachScheduler(adapter, false) }
    }

    const stubSwitch = (adapter: UniversalVideoAdapter) =>
      track(vi.spyOn(adapter as any, "switchSubtitlesFetcher").mockResolvedValue(undefined))
    const stubCoordinatorStart = () =>
      track(vi.spyOn(TranslationCoordinator.prototype, "start").mockImplementation(() => undefined))
    const tryAutoStart = (adapter: UniversalVideoAdapter) =>
      (adapter as any).tryAutoStartSubtitles() as Promise<void>

    // The player is mounted again for the video now showing, as a navigation leaves it.
    function remount(adapter: UniversalVideoAdapter) {
      ;(adapter as any).resetForNavigation()
      return attachScheduler(adapter, false)
    }

    function embeddedPlayer(paused: boolean) {
      const listeners = new Map<string, () => void>()
      const element = {
        paused,
        currentTime: 0,
        addEventListener: vi.fn<(type: string, listener: () => void) => void>((type, listener) => {
          listeners.set(type, listener)
        }),
        removeEventListener: vi.fn<(type: string, listener: () => void) => void>(
          (type, listener) => {
            if (listeners.get(type) === listener) listeners.delete(type)
          },
        ),
      }
      return { element, listeners, play: () => listeners.get("playing")?.() }
    }

    // A session an earlier start left running on video "A", as a resume would find it.
    function runningSession(adapter: UniversalVideoAdapter) {
      const coordinator = {
        clearFailed: vi.fn<(...args: any[]) => any>(),
        start: vi.fn<(...args: any[]) => any>(),
        stop: vi.fn<(...args: any[]) => any>(),
      }
      ;(adapter as any).sessionProcessedFragments = [
        { text: "old", start: 0, end: 1000, translation: "old translation" },
      ]
      ;(adapter as any).sessionVideoId = "A"
      ;(adapter as any).translationCoordinator = coordinator
      return coordinator
    }

    const startContext = (surface: string) => ({
      feature: ANALYTICS_FEATURE.VIDEO_SUBTITLES,
      surface,
      startedAt: 0,
    })

    beforeEach(() => {
      // A value queued with mockReturnValueOnce survives clearAllMocks; start each test without one.
      mocks.resolveSubtitlesProviderRef.mockReset()
      mocks.getLocalConfig.mockResolvedValue(configFor())
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
    })

    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore()
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
      subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
    })

    it("starts for a video in another language, reading the language before anything is shown", async () => {
      const { adapter, subtitlesFetcher, scheduler } = openVideo()
      const switchSpy = stubSwitch(adapter)
      const fetching = deferred<typeof FRAGMENTS>()
      subtitlesFetcher.fetch.mockReturnValueOnce(fetching.promise)

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce())

      // While the captions load there is nothing on the player and no provider is involved.
      expect(switchSpy).not.toHaveBeenCalled()
      expect(scheduler.start).not.toHaveBeenCalled()
      expect(scheduler.show).not.toHaveBeenCalled()
      expect(scheduler.setState).not.toHaveBeenCalled()
      expect((adapter as any).hideNativeSubtitles).not.toHaveBeenCalled()
      expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
      expect(mocks.translateSubtitles).not.toHaveBeenCalled()

      fetching.resolve(FRAGMENTS)
      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledOnce())
      expect(switchSpy).toHaveBeenCalledExactlyOnceWith(...AUTO_START_ARGS)
      expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
    })

    it("reuses the captions it fetched instead of fetching them again to translate", async () => {
      const startSpy = stubCoordinatorStart()
      const { adapter, subtitlesFetcher } = openVideo()

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledOnce())

      expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    })

    it("does not even fetch the captions while autoStart is off", async () => {
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart: false }))
      const { adapter, subtitlesFetcher, scheduler } = openVideo()
      const switchSpy = stubSwitch(adapter)

      await tryAutoStart(adapter)
      await settle()

      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
      expect(subtitlesFetcher.hasAvailableSubtitles).not.toHaveBeenCalled()
      expect(switchSpy).not.toHaveBeenCalled()
      expect(scheduler.setState).not.toHaveBeenCalled()
    })

    it("leaves a video alone when the learning panel is open but autoStart is off, and the transcript still loads", async () => {
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart: false }))
      const { adapter, scheduler } = openVideo()
      const switchSpy = stubSwitch(adapter)
      const startSpy = stubCoordinatorStart()
      subtitlesStore.set(subtitlesSidebarOpenAtom, true)

      await tryAutoStart(adapter)
      await adapter.ensureSourceTrackPublished()
      await settle()

      expect(subtitlesStore.get(sourceTrackAtom).length).toBeGreaterThan(0)
      expect(switchSpy).not.toHaveBeenCalled()
      expect(startSpy).not.toHaveBeenCalled()
      expect(scheduler.show).not.toHaveBeenCalled()
      expect(scheduler.setState).not.toHaveBeenCalled()
      expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
    })

    it.each([
      ["en", "eng"],
      ["en-US", "eng"],
      ["ko-KR", "kor"],
      ["zh-TW", "cmn-Hant"],
    ])(
      "does not translate a %s video for a viewer whose translation language is %s, with autoStart on",
      async (language, targetCode) => {
        mocks.getLocalConfig.mockResolvedValue(configFor({ targetCode }))
        const { adapter, subtitlesFetcher, scheduler } = openVideo({ language })
        const switchSpy = stubSwitch(adapter)

        await tryAutoStart(adapter)
        await settle()

        // The captions were read to find out, and nothing more was done with them.
        expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
        expect(switchSpy).not.toHaveBeenCalled()
        expect(scheduler.show).not.toHaveBeenCalled()
        expect(scheduler.supplementSubtitles).not.toHaveBeenCalled()
        expect((adapter as any).hideNativeSubtitles).not.toHaveBeenCalled()
        expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      },
    )

    it.each([[""], ["xx"]])(
      "holds back a video whose language is %j, without a word",
      async (language) => {
        const { adapter, scheduler } = openVideo({ language })
        const switchSpy = stubSwitch(adapter)

        await tryAutoStart(adapter)
        await settle()

        expect(switchSpy).not.toHaveBeenCalled()
        expect(scheduler.setState).not.toHaveBeenCalled()
        expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      },
    )

    it("holds back silently when the captions cannot be read", async () => {
      const { adapter, subtitlesFetcher, scheduler } = openVideo()
      const switchSpy = stubSwitch(adapter)
      subtitlesFetcher.fetch.mockRejectedValue(new OverlaySubtitlesError("noSubtitlesFound"))

      await tryAutoStart(adapter)
      await settle()

      expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
      expect(switchSpy).not.toHaveBeenCalled()
      expect(scheduler.setState).not.toHaveBeenCalled()
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
    })

    it.each([
      ["autoStart is turned off", { autoStart: false }],
      ["the translation language becomes the video's", { targetCode: "jpn" }],
    ])("reads the settings again once the captions arrive: %s", async (_case, changed) => {
      const { adapter, subtitlesFetcher } = openVideo()
      const switchSpy = stubSwitch(adapter)
      const fetching = deferred<typeof FRAGMENTS>()
      subtitlesFetcher.fetch.mockReturnValueOnce(fetching.promise)

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce())
      mocks.getLocalConfig.mockResolvedValue(configFor(changed))
      fetching.resolve(FRAGMENTS)
      await settle()

      expect(switchSpy).not.toHaveBeenCalled()
    })

    it.each([
      ["button", (adapter: UniversalVideoAdapter) => adapter.toggleSubtitlesManually(false)],
      ["shortcut", (adapter: UniversalVideoAdapter) => adapter.toggleSubtitlesByShortcut(false)],
    ])("lets a switch-off from the %s win before the language is known", async (_via, off) => {
      const { adapter, subtitlesFetcher } = openVideo()
      const switchSpy = stubSwitch(adapter)

      off(adapter)
      await tryAutoStart(adapter)
      await settle()

      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
      expect(switchSpy).not.toHaveBeenCalled()
    })

    it("lets a switch-off win while the captions are still loading", async () => {
      const { adapter, subtitlesFetcher } = openVideo()
      const switchSpy = stubSwitch(adapter)
      const fetching = deferred<typeof FRAGMENTS>()
      subtitlesFetcher.fetch.mockReturnValueOnce(fetching.promise)

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce())
      adapter.toggleSubtitlesManually(false)
      fetching.resolve(FRAGMENTS)
      await settle()

      expect(switchSpy).not.toHaveBeenCalled()
    })

    it("ends a stale attempt when the captions arrive, without reading the settings again", async () => {
      const { adapter, subtitlesFetcher } = openVideo()
      const switchSpy = stubSwitch(adapter)
      const fetching = deferred<typeof FRAGMENTS>()
      subtitlesFetcher.fetch.mockReturnValueOnce(fetching.promise)

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce())
      adapter.toggleSubtitlesManually(false)
      const readsBefore = mocks.getLocalConfig.mock.calls.length
      fetching.resolve(FRAGMENTS)
      await settle()

      expect(mocks.getLocalConfig).toHaveBeenCalledTimes(readsBefore)
      expect(switchSpy).not.toHaveBeenCalled()
    })

    it("starts no coordinator when autoStart is turned off while the captions load", async () => {
      const startSpy = stubCoordinatorStart()
      const { adapter, subtitlesFetcher, scheduler } = openVideo()
      const fetching = deferred<typeof FRAGMENTS>()
      subtitlesFetcher.fetch.mockReturnValueOnce(fetching.promise)

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce())
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart: false }))
      fetching.resolve(FRAGMENTS)
      await settle()

      expect(startSpy).not.toHaveBeenCalled()
      expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
      expect(scheduler.show).not.toHaveBeenCalled()
      expect(scheduler.setState).not.toHaveBeenCalled()
    })

    it("starts no coordinator, and puts the native captions back, when autoStart is turned off while the provider resolves", async () => {
      const startSpy = stubCoordinatorStart()
      const provider = deferred<null>()
      mocks.resolveSubtitlesProviderRef.mockReturnValueOnce(provider.promise)
      const { adapter, scheduler } = openVideo()

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(mocks.resolveSubtitlesProviderRef).toHaveBeenCalledOnce())
      // The start had put the player up and the native captions away by now.
      expect(scheduler.show).toHaveBeenCalled()
      expect((adapter as any).hideNativeSubtitles).toHaveBeenCalled()
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart: false }))
      provider.resolve(null)
      await settle()

      expect(startSpy).not.toHaveBeenCalled()
      expect((adapter as any).translationCoordinator).toBeNull()
      expect(scheduler.hide).toHaveBeenCalledOnce()
      expect((adapter as any).showNativeSubtitles).toHaveBeenCalledOnce()
      expect(scheduler.setState).toHaveBeenLastCalledWith("idle")
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      expect(mocks.translateSubtitles).not.toHaveBeenCalled()
    })

    it("lets a manual start go on, and leaves its player alone, when autoStart goes off under a pending automatic one", async () => {
      const startSpy = stubCoordinatorStart()
      const autoProvider = deferred<null>()
      mocks.resolveSubtitlesProviderRef.mockReturnValueOnce(autoProvider.promise)
      const { adapter, scheduler } = openVideo()

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(mocks.resolveSubtitlesProviderRef).toHaveBeenCalledOnce())
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart: false }))
      adapter.toggleSubtitlesManually(true)
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledOnce())
      autoProvider.resolve(null)
      await settle()

      // Only the viewer's own start ran; the automatic one found itself superseded and stood down
      // without hiding what the manual one put up or clearing its loading state.
      expect(startSpy).toHaveBeenCalledOnce()
      expect(scheduler.hide).not.toHaveBeenCalled()
      expect((adapter as any).showNativeSubtitles).not.toHaveBeenCalled()
      expect(scheduler.setState).not.toHaveBeenLastCalledWith("idle")
    })

    // A resume sets no player state of its own; a start turned down clears the loading state.
    it.each([
      [
        "an automatic start, with autoStart on",
        ANALYTICS_SURFACE.VIDEO_SUBTITLES_AUTO,
        true,
        { resumes: true, coordinatorStarts: 1, hides: 0, lastState: undefined },
      ],
      [
        "a manual start, with autoStart off",
        ANALYTICS_SURFACE.VIDEO_SUBTITLES,
        false,
        { resumes: true, coordinatorStarts: 1, hides: 0, lastState: undefined },
      ],
      [
        "an automatic start, with autoStart off",
        ANALYTICS_SURFACE.VIDEO_SUBTITLES_AUTO,
        false,
        { resumes: false, coordinatorStarts: 0, hides: 1, lastState: "idle" },
      ],
    ])("resumes a running session for %s", async (_case, surface, autoStart, expected) => {
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart }))
      const { adapter, scheduler } = openVideo()
      const coordinator = runningSession(adapter)

      await expect((adapter as any).startTranslation(startContext(surface))).resolves.toBe(
        expected.resumes,
      )

      expect(coordinator.start).toHaveBeenCalledTimes(expected.coordinatorStarts)
      // Turned down, the automatic start puts back what it changed and nothing else.
      expect(scheduler.hide).toHaveBeenCalledTimes(expected.hides)
      expect(scheduler.setState.mock.calls.at(-1)?.[0]).toBe(expected.lastState)
    })

    it("lets a switch-off win while the provider is still resolving, and no coordinator starts", async () => {
      const startSpy = stubCoordinatorStart()
      const provider = deferred<null>()
      mocks.resolveSubtitlesProviderRef.mockReturnValueOnce(provider.promise)
      const { adapter, scheduler } = openVideo()

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(mocks.resolveSubtitlesProviderRef).toHaveBeenCalledOnce())
      adapter.toggleSubtitlesManually(false)
      provider.resolve(null)
      await settle()

      expect(startSpy).not.toHaveBeenCalled()
      expect((adapter as any).translationCoordinator).toBeNull()
      expect(scheduler.hide).toHaveBeenCalled()
      // The loading pill goes with it, and nothing reads as a failure.
      expect(scheduler.setState).toHaveBeenLastCalledWith("idle")
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      expect(mocks.translateSubtitles).not.toHaveBeenCalled()
    })

    it("lets a switch-off win over a manual start that is still loading its settings", async () => {
      const startSpy = stubCoordinatorStart()
      const settings = deferred<ReturnType<typeof configFor>>()
      mocks.getLocalConfig.mockReturnValueOnce(settings.promise)
      const { adapter, scheduler } = openVideo()

      adapter.toggleSubtitlesManually(true)
      adapter.toggleSubtitlesManually(false)
      settings.resolve(configFor())
      await settle()

      expect(startSpy).not.toHaveBeenCalled()
      expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
      expect(scheduler.setState).toHaveBeenLastCalledWith("idle")
    })

    it("still stops a coordinator that is already running when the viewer switches off", async () => {
      const startSpy = stubCoordinatorStart()
      const stopSpy = track(
        vi.spyOn(TranslationCoordinator.prototype, "stop").mockImplementation(() => undefined),
      )
      const { adapter, scheduler } = openVideo()

      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledOnce())
      adapter.toggleSubtitlesManually(false)

      expect(stopSpy).toHaveBeenCalledOnce()
      expect(scheduler.hide).toHaveBeenCalledOnce()
    })

    it("keeps a switch-off through a panel open, a track change and a remount of the same video", async () => {
      const { adapter, subtitlesFetcher } = openVideo({ videoId: "A" })
      const switchSpy = stubSwitch(adapter)

      adapter.toggleSubtitlesManually(false)
      subtitlesStore.set(subtitlesSidebarOpenAtom, true)
      await adapter.handleSourceTrackChanged()
      remount(adapter)
      await tryAutoStart(adapter)
      await settle()

      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
      expect(switchSpy).not.toHaveBeenCalled()
    })

    it("starts afresh for the next video, whose id is not the one that was switched off", async () => {
      const { adapter, video } = openVideo({ videoId: "A" })
      const switchSpy = stubSwitch(adapter)

      adapter.toggleSubtitlesManually(false)
      video.id = "B"
      remount(adapter)
      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledExactlyOnceWith(...AUTO_START_ARGS))
    })

    it("forgets a switch-off when the page gives no video id to match it against", async () => {
      const { adapter } = openVideo({ videoId: null })
      const switchSpy = stubSwitch(adapter)

      adapter.toggleSubtitlesManually(false)
      remount(adapter)
      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledExactlyOnceWith(...AUTO_START_ARGS))
    })

    it("lets a later switch-on replace a switch-off for the same video", async () => {
      const startSpy = stubCoordinatorStart()
      const { adapter } = openVideo()

      adapter.toggleSubtitlesManually(false)
      adapter.toggleSubtitlesManually(true)

      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledOnce())
    })

    it("lets a manual start through with autoStart off and a language nobody could read", async () => {
      mocks.getLocalConfig.mockResolvedValue(configFor({ autoStart: false }))
      const startSpy = stubCoordinatorStart()
      const { adapter } = openVideo({ language: "" })

      adapter.toggleSubtitlesManually(true)

      await vi.waitFor(() => expect(startSpy).toHaveBeenCalledOnce())
      expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
    })

    it("lets an AI request through after the viewer switched the video off", async () => {
      const startSpy = stubCoordinatorStart()
      const { adapter, subtitlesFetcher } = openVideo()
      const aiFetcher = { ...subtitlesFetcher, cleanup: vi.fn<(...args: any[]) => any>() }
      ;(adapter as any).fetchers = { native: (adapter as any).fetchers.native, ai: () => aiFetcher }

      adapter.toggleSubtitlesManually(false)
      await adapter.requestAiSubtitles()

      expect(startSpy).toHaveBeenCalledOnce()
    })

    it("ignores a play that was already queued for the video it was waiting on", async () => {
      const { adapter, subtitlesFetcher, scheduler, video } = openVideo({ embedded: true })
      const switchSpy = stubSwitch(adapter)
      const player = embeddedPlayer(true)
      scheduler.getVideoElement.mockReturnValue(player.element)

      await tryAutoStart(adapter)
      const queued = player.listeners.get("playing")!
      expect(queued).toBeDefined()
      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()

      video.id = "B"
      remount(adapter)
      expect(player.element.removeEventListener).toHaveBeenCalledWith("playing", queued)
      queued()
      await settle()

      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
      expect(switchSpy).not.toHaveBeenCalled()
    })

    it("waits for an embedded player to play, then tries once", async () => {
      const { adapter, subtitlesFetcher, scheduler } = openVideo({ embedded: true })
      const switchSpy = stubSwitch(adapter)
      const player = embeddedPlayer(true)
      scheduler.getVideoElement.mockReturnValue(player.element)

      await tryAutoStart(adapter)
      await tryAutoStart(adapter)
      await settle()
      expect(player.element.addEventListener).toHaveBeenCalledOnce()
      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()

      player.play()
      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledExactlyOnceWith(...AUTO_START_ARGS))

      expect(player.element.removeEventListener).toHaveBeenCalledWith(
        "playing",
        expect.any(Function),
      )
      expect(player.listeners.size).toBe(0)
      expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
    })

    it("does not wait for an embedded player that is already playing", async () => {
      const { adapter, scheduler } = openVideo({ embedded: true })
      const switchSpy = stubSwitch(adapter)
      const player = embeddedPlayer(false)
      scheduler.getVideoElement.mockReturnValue(player.element)

      await tryAutoStart(adapter)

      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledExactlyOnceWith(...AUTO_START_ARGS))
      expect(player.element.addEventListener).not.toHaveBeenCalled()
    })

    it("lets a switch-off win while an embedded player has not played yet", async () => {
      const { adapter, subtitlesFetcher, scheduler } = openVideo({ embedded: true })
      const switchSpy = stubSwitch(adapter)
      const player = embeddedPlayer(true)
      scheduler.getVideoElement.mockReturnValue(player.element)

      await tryAutoStart(adapter)
      adapter.toggleSubtitlesManually(false)
      player.play()
      await settle()

      expect(subtitlesFetcher.fetch).not.toHaveBeenCalled()
      expect(switchSpy).not.toHaveBeenCalled()
    })

    it("makes one attempt per video load, however often it is asked", async () => {
      const { adapter, subtitlesFetcher } = openVideo()
      const switchSpy = stubSwitch(adapter)

      await tryAutoStart(adapter)
      await tryAutoStart(adapter)
      await tryAutoStart(adapter)
      await settle()

      expect(subtitlesFetcher.fetch).toHaveBeenCalledOnce()
      expect(switchSpy).toHaveBeenCalledOnce()
    })

    it("makes a new attempt for the next load", async () => {
      const { adapter, subtitlesFetcher, video } = openVideo()
      const switchSpy = stubSwitch(adapter)
      await tryAutoStart(adapter)
      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledOnce())

      video.id = "B"
      remount(adapter)
      await tryAutoStart(adapter)

      await vi.waitFor(() => expect(switchSpy).toHaveBeenCalledTimes(2))
      expect(subtitlesFetcher.fetch).toHaveBeenCalledTimes(2)
    })

    describe("without a chosen subtitles provider", () => {
      it("keeps the originals, says why once, and never calls a provider", async () => {
        mocks.getLocalConfig.mockResolvedValue(configFor({ withProvider: false }))
        const startSpy = stubCoordinatorStart()
        const { adapter, scheduler, video } = openVideo()

        await tryAutoStart(adapter)
        await vi.waitFor(() => expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledOnce())

        expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledExactlyOnceWith(
          "providerRequired.message",
          {
            label: "providerRequired.openSettings",
            url: expect.stringContaining(SETTINGS_URL),
          },
        )
        expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
        const sourceTrack = subtitlesStore.get(sourceTrackAtom)
        expect(sourceTrack.length).toBeGreaterThan(0)
        expect(sourceTrack.every((cue) => cue.translation === undefined)).toBe(true)
        expect(scheduler.setState).toHaveBeenLastCalledWith("idle")

        // The next foreign video is blocked the same way, without saying it again.
        video.id = "B"
        const nextScheduler = remount(adapter)
        await tryAutoStart(adapter)
        await vi.waitFor(() => expect(nextScheduler.setState).toHaveBeenCalledWith("idle"))
        await settle()
        expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
        expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledOnce()

        // The viewer's own press is never silenced.
        adapter.toggleSubtitlesManually(true)
        await vi.waitFor(() => expect(mocks.showSubtitlesErrorToast).toHaveBeenCalledTimes(2))

        expect(startSpy).not.toHaveBeenCalled()
        expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
        expect(mocks.translateSubtitles).not.toHaveBeenCalled()
      })

      it("shows the originals as they are, with no toast, when only originals are wanted", async () => {
        mocks.getLocalConfig.mockResolvedValue(
          configFor({ withProvider: false, displayMode: "originalOnly" }),
        )
        const startSpy = stubCoordinatorStart()
        const { adapter, scheduler } = openVideo()

        await tryAutoStart(adapter)
        await vi.waitFor(() => expect(scheduler.setState).toHaveBeenLastCalledWith("idle"))
        await settle()

        expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(true)
        expect(
          subtitlesStore.get(sourceTrackAtom).every((cue) => cue.translation === undefined),
        ).toBe(true)
        expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
        expect(startSpy).not.toHaveBeenCalled()
        expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
        expect(mocks.translateSubtitles).not.toHaveBeenCalled()
      })

      it("still holds back a video already in the viewer's language, with no refusal either", async () => {
        mocks.getLocalConfig.mockResolvedValue(
          configFor({ withProvider: false, targetCode: "jpn" }),
        )
        const { adapter, scheduler } = openVideo({ language: "ja" })
        const switchSpy = stubSwitch(adapter)

        await tryAutoStart(adapter)
        await settle()

        expect(switchSpy).not.toHaveBeenCalled()
        expect(scheduler.setState).not.toHaveBeenCalled()
        expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
        expect(mocks.showSubtitlesErrorToast).not.toHaveBeenCalled()
      })
    })
  })
})
