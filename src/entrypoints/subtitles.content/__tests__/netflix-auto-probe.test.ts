// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { listenForSubtitlesRequests } from "@/entrypoints/netflix-interceptor.content/player"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  HIDE_NATIVE_CAPTIONS_STYLE_ID,
  NETFLIX_LOAD_TIMEOUT_MS,
  NETFLIX_SUBTITLES_REQUEST_TYPE,
  NETFLIX_SUBTITLES_RESPONSE_TYPE,
} from "@/utils/constants/subtitles"
import { NetflixSubtitlesFetcher } from "@/utils/subtitles/fetchers/netflix"
import { TranslationCoordinator } from "../translation-coordinator"
import { UniversalVideoAdapter } from "../universal-adapter"

const mocks = vi.hoisted(() => ({
  capture: { ttml: null as string | null },
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
  resolveSubtitlesProviderRef: vi.fn<(...args: any[]) => any>(),
  fetchSubtitlesSummary: vi.fn<(...args: any[]) => any>(),
  translateSubtitles: vi.fn<(...args: any[]) => any>(),
}))

// The page side is real except for what Netflix itself would supply: the player and the file.
vi.mock("@/entrypoints/netflix-interceptor.content/ttml-capture", () => ({
  findCapturedTtml: () => mocks.capture.ttml,
}))
vi.mock("@/utils/config/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/config/storage")>()),
  getLocalConfig: mocks.getLocalConfig,
}))
vi.mock("@/utils/subtitles/processor/translator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/subtitles/processor/translator")>()),
  resolveSubtitlesProviderRef: mocks.resolveSubtitlesProviderRef,
  fetchSubtitlesSummary: mocks.fetchSubtitlesSummary,
  translateSubtitles: mocks.translateSubtitles,
}))
vi.mock("@/utils/subtitles/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/subtitles/toast")>()),
  showSubtitlesErrorToast: vi.fn<(...args: any[]) => any>(),
  showAiSubtitlesWallToast: vi.fn<(...args: any[]) => any>(),
}))

const TTML = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en">
<body><div><p begin="10000000t" end="20000000t">Hello there.</p></div></body>
</tt>`

const track = (trackId: string, bcp47: string | null, none = false) => ({
  trackId,
  bcp47,
  isNoneTrack: none,
  isForcedNarrative: false,
})
const OFF = track("off", null, true)
const ZH = track("zh-Hant", "zh-Hant")
const EN = track("en", "en")

// The viewer has Netflix's subtitles off; the audio is Chinese, so a load turns the Chinese track on.
let current = OFF
let playerReady = true
let movieId = 1
const setTrack = vi.fn<(next: typeof OFF) => void>((next) => {
  current = next
})
const player = {
  getMovieId: () => movieId,
  getAudioTrack: () => ({ bcp47: "zh-CN" }),
  getTimedTextTrack: () => current,
  getTimedTextTrackList: () => (playerReady ? [OFF, ZH, EN] : []),
  setTimedTextTrack: setTrack,
}

// Everything the content script posts to the page, and the page's answers, in order.
const posted: Array<{ type?: string; action?: string; requestId?: string }> = []
// Load requests kept from the page until released, to land them after a later request.
let holdLoads = false
const heldLoads: Array<() => void> = []

function deliver(data: unknown) {
  setTimeout(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }))
  })
}

beforeAll(() => {
  ;(window as any).netflix = {
    appContext: {
      state: {
        playerApp: {
          getAPI: () => ({
            videoPlayer: {
              getAllPlayerSessionIds: () => ["watch-1"],
              getVideoPlayerBySessionId: () => player,
            },
          }),
        },
      },
    },
  }
  listenForSubtitlesRequests()
})

const PROVIDER_ID = "netflix-probe-provider"
function configFor(targetCode: string, autoStart = true) {
  return {
    language: { targetCode },
    providersConfig: [
      { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true },
    ],
    videoSubtitles: {
      autoStart,
      aiSegmentation: false,
      providerId: PROVIDER_ID,
      style: { displayMode: "bilingual" },
    },
  }
}

let adapterVideoId = "1"
let adapter: UniversalVideoAdapter
let scheduler: Record<string, ReturnType<typeof vi.fn<(...args: any[]) => any>>>
let coordinatorStart: { mock: { calls: unknown[][] } }

function newScheduler() {
  return {
    isActive: vi.fn<(...args: any[]) => any>(() => false),
    reset: vi.fn<(...args: any[]) => any>(),
    stop: vi.fn<(...args: any[]) => any>(),
    start: vi.fn<(...args: any[]) => any>(),
    show: vi.fn<(...args: any[]) => any>(),
    hide: vi.fn<(...args: any[]) => any>(),
    setState: vi.fn<(...args: any[]) => any>(),
    supplementSubtitles: vi.fn<(...args: any[]) => any>(),
    getVideoElement: vi.fn<(...args: any[]) => any>(() => ({ currentTime: 0 })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  current = OFF
  playerReady = true
  movieId = 1
  adapterVideoId = "1"
  // A watch URL naming the movie the player shows: the page checks both before it changes a track.
  window.history.pushState({}, "", "/watch/1")
  mocks.capture.ttml = TTML
  mocks.getLocalConfig.mockResolvedValue(configFor("kor"))
  mocks.resolveSubtitlesProviderRef.mockReset()
  mocks.fetchSubtitlesSummary.mockResolvedValue(undefined)
  posted.length = 0
  holdLoads = false
  heldLoads.length = 0
  // jsdom posts messages without an origin, and both ends of the bridge check it.
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    const message = data as { type?: string; action?: string; requestId?: string }
    posted.push(message)
    if (holdLoads && message.type === NETFLIX_SUBTITLES_REQUEST_TYPE && message.action === "load") {
      heldLoads.push(() => deliver(data))
      return
    }
    deliver(data)
  })
  coordinatorStart = vi
    .spyOn(TranslationCoordinator.prototype, "start")
    .mockImplementation(() => undefined)

  adapter = new UniversalVideoAdapter({
    config: {
      selectors: {
        video: "video",
        playerContainer: ".player",
        nativeSubtitles: ".player-timedtext",
      },
      events: {},
      getVideoId: () => adapterVideoId,
    },
    fetchers: { native: () => new NetflixSubtitlesFetcher() },
  })
  scheduler = newScheduler()
  ;(adapter as any).subtitlesScheduler = scheduler
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.pushState({}, "", "/")
  document.getElementById(HIDE_NATIVE_CAPTIONS_STYLE_ID)?.remove()
})

const tryAutoStart = () => (adapter as any).tryAutoStartSubtitles() as Promise<void>
// The probe on its own, so a test can wait for it to settle instead of for a timer.
const runProbe = () =>
  (adapter as any).runAutoStart((adapter as any).captureSwitchToken()) as Promise<void>
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// The tracks the page was told to switch to, in order.
const switchedTo = () => setTrack.mock.calls.map(([next]) => next.trackId)
const requests = (action: string) =>
  posted.filter(
    (message) => message.type === NETFLIX_SUBTITLES_REQUEST_TYPE && message.action === action,
  )
const responseTo = (requestId: string | undefined) =>
  posted.find(
    (message) =>
      message.type === NETFLIX_SUBTITLES_RESPONSE_TYPE && message.requestId === requestId,
  )

function releaseHeldLoads() {
  holdLoads = false
  for (const release of heldLoads.splice(0)) release()
}

// The player is mounted again for the same page, as a remount leaves it.
function remount() {
  ;(adapter as any).resetForNavigation()
  scheduler = newScheduler()
  ;(adapter as any).subtitlesScheduler = scheduler
}

describe("probing a Netflix video's language for auto-translate", () => {
  it("puts the viewer's subtitles back off when the video is already in their language", async () => {
    mocks.getLocalConfig.mockResolvedValue(configFor("eng"))

    await tryAutoStart()

    // The load turned the Chinese track on to reach its file; declining turns it off again.
    await vi.waitFor(() => expect(switchedTo()).toEqual(["zh-Hant", "off"]))
    expect(current).toBe(OFF)
    expect(scheduler.show).not.toHaveBeenCalled()
    expect(coordinatorStart.mock.calls).toHaveLength(0)
    expect(document.getElementById(HIDE_NATIVE_CAPTIONS_STYLE_ID)).toBeNull()
  })

  it("leaves the track on for the translation the probe went on to start", async () => {
    await tryAutoStart()

    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))
    await delay(200)
    expect(switchedTo()).toEqual(["zh-Hant"])
    expect(current).toBe(ZH)
    expect(requests("restore")).toHaveLength(0)
    expect(document.getElementById(HIDE_NATIVE_CAPTIONS_STYLE_ID)).not.toBeNull()
  })

  it("does not restore the track from under a manual start that began while the probe loaded", async () => {
    mocks.capture.ttml = null

    await tryAutoStart()
    await vi.waitFor(() => expect(switchedTo()).toEqual(["zh-Hant"]))
    adapter.toggleSubtitlesManually(true)
    mocks.capture.ttml = TTML

    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))
    await delay(300)
    expect(switchedTo()).toEqual(["zh-Hant"])
    expect(current).toBe(ZH)
    expect(requests("restore")).toHaveLength(0)
  })

  it("puts the track back after a switch-off whose restore reached the page before the load did", async () => {
    holdLoads = true

    await tryAutoStart()
    await vi.waitFor(() => expect(heldLoads).toHaveLength(1))
    adapter.toggleSubtitlesManually(false)
    await vi.waitFor(() => expect(requests("restore")).toHaveLength(1))
    await delay(50)
    // The page had nothing to put back yet: the load has not enabled anything.
    expect(switchedTo()).toEqual([])

    releaseHeldLoads()

    // The load enables the track late; the probe's own restore, after it settled, undoes that.
    await vi.waitFor(() => expect(switchedTo()).toEqual(["zh-Hant", "off"]))
    expect(current).toBe(OFF)
    expect(requests("restore")).toHaveLength(2)
    expect(coordinatorStart.mock.calls).toHaveLength(0)
  })
})

describe("a Netflix load that waits for the player", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    playerReady = false
    window.history.pushState({}, "", "/watch/1")
    adapterVideoId = "1"
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("enables nothing after a switch-off and a remount of the same movie, once the player is ready", async () => {
    const probe = runProbe()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))

    adapter.toggleSubtitlesManually(false)
    remount()
    await tryAutoStart()
    playerReady = true
    await vi.advanceTimersByTimeAsync(1000)
    await probe

    // The page answered the abandoned load, without acting on it.
    expect(requests("cancel")).toHaveLength(1)
    expect(responseTo(requests("load")[0]!.requestId)).toMatchObject({ movieId: null, ttml: null })
    expect(switchedTo()).toEqual([])
    expect(current).toBe(OFF)
  })

  it("enables nothing on the next movie's player when the load waited through the navigation", async () => {
    const probe = runProbe()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))

    // The page moves on before anything has cleaned up: its own check of the movie must refuse.
    window.history.pushState({}, "", "/watch/2")
    adapterVideoId = "2"
    movieId = 2
    playerReady = true
    await vi.advanceTimersByTimeAsync(1000)
    await probe

    expect(requests("cancel")).toHaveLength(0)
    expect(responseTo(requests("load")[0]!.requestId)).toMatchObject({ movieId: null, ttml: null })
    expect(switchedTo()).toEqual([])
    expect(current).toBe(OFF)
  })

  it("enables nothing for a movie whose remount found autoStart off", async () => {
    const probe = runProbe()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))

    mocks.getLocalConfig.mockResolvedValue(configFor("kor", false))
    window.history.pushState({}, "", "/watch/2")
    adapterVideoId = "2"
    movieId = 2
    remount()
    await tryAutoStart()
    playerReady = true
    await vi.advanceTimersByTimeAsync(1000)
    await probe

    expect(requests("load")).toHaveLength(1)
    expect(requests("cancel")).toHaveLength(1)
    expect(responseTo(requests("load")[0]!.requestId)).toMatchObject({ movieId: null })
    expect(switchedTo()).toEqual([])
    expect(current).toBe(OFF)
  })

  it("lets the viewer's newer manual start through while an older probe waited", async () => {
    const probe = runProbe()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))
    adapter.toggleSubtitlesManually(true)
    await vi.waitFor(() => expect(requests("load")).toHaveLength(2))

    playerReady = true
    await vi.advanceTimersByTimeAsync(1000)
    await probe
    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))

    // Neither load was given up: the first enabled the track, the second found it enabled.
    expect(switchedTo()).toEqual(["zh-Hant"])
    expect(current).toBe(ZH)
    expect(requests("restore")).toHaveLength(0)
  })

  it("loads for the replay after a remount while the cancelled start's load does nothing", async () => {
    adapter.toggleSubtitlesManually(true)
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))

    remount()
    await tryAutoStart()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(2))
    playerReady = true
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))

    const [cancelled, replayed] = requests("load")
    expect(responseTo(cancelled!.requestId)).toMatchObject({ movieId: null })
    expect(responseTo(replayed!.requestId)).toMatchObject({ movieId: 1, trackId: "zh-Hant" })
    expect(switchedTo()).toEqual(["zh-Hant"])
    expect(current).toBe(ZH)
  })

  it("waits for the player to show the movie the page names before it loads, then loads for it", async () => {
    mocks.getLocalConfig.mockResolvedValue(configFor("eng"))
    window.history.pushState({}, "", "/watch/2")
    adapterVideoId = "2"
    // Ready, but still on the movie before.
    playerReady = true
    const probe = runProbe()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(3000)
    expect(switchedTo()).toEqual([])
    expect(current).toBe(OFF)

    movieId = 2
    await vi.advanceTimersByTimeAsync(1000)
    await probe
    await vi.advanceTimersByTimeAsync(500)

    // Enabled only once the player showed movie 2, and put back when the probe found it in the
    // viewer's own language.
    expect(responseTo(requests("load")[0]!.requestId)).toMatchObject({
      movieId: 2,
      trackId: "zh-Hant",
    })
    expect(switchedTo()).toEqual(["zh-Hant", "off"])
    expect(current).toBe(OFF)
  })

  it("returns without a change when the player never shows the movie the page names", async () => {
    window.history.pushState({}, "", "/watch/2")
    adapterVideoId = "2"
    playerReady = true
    const probe = runProbe()
    await vi.waitFor(() => expect(requests("load")).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(NETFLIX_LOAD_TIMEOUT_MS + 1000)
    await probe

    // No fallback to the title the player does show.
    expect(responseTo(requests("load")[0]!.requestId)).toMatchObject({ movieId: null, ttml: null })
    expect(switchedTo()).toEqual([])
    expect(current).toBe(OFF)
  })

  it("puts the track back at cleanup while the original player still shows the movie, though the URL moved first", async () => {
    mocks.capture.ttml = null
    playerReady = true
    const probe = runProbe()
    await vi.waitFor(() => expect(switchedTo()).toEqual(["zh-Hant"]))

    window.history.pushState({}, "", "/watch/2")
    adapterVideoId = "2"
    remount()
    await vi.advanceTimersByTimeAsync(1000)
    await probe

    expect(requests("cancel")).toHaveLength(1)
    expect(switchedTo()).toEqual(["zh-Hant", "off"])
    expect(current).toBe(OFF)
  })

  it("does not reach into the next movie's player at cleanup", async () => {
    mocks.capture.ttml = null
    playerReady = true
    const probe = runProbe()
    await vi.waitFor(() => expect(switchedTo()).toEqual(["zh-Hant"]))

    window.history.pushState({}, "", "/watch/2")
    adapterVideoId = "2"
    movieId = 2
    remount()
    await vi.advanceTimersByTimeAsync(1000)
    await probe

    expect(requests("cancel")).toHaveLength(1)
    expect(switchedTo()).toEqual(["zh-Hant"])
  })
})
