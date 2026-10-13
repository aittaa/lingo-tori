// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { injectPlayerApi } from "@/entrypoints/interceptor.content/inject-player-api"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  ENSURE_SUBTITLES_REQUEST_TYPE,
  ENSURE_SUBTITLES_RESPONSE_TYPE,
  HIDE_NATIVE_CAPTIONS_STYLE_ID,
} from "@/utils/constants/subtitles"
import { YoutubeSubtitlesFetcher } from "@/utils/subtitles/fetchers/youtube"
import { TranslationCoordinator } from "../translation-coordinator"
import { UniversalVideoAdapter } from "../universal-adapter"

const mocks = vi.hoisted(() => ({
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
  resolveSubtitlesProviderRef: vi.fn<(...args: any[]) => any>(),
  fetchSubtitlesSummary: vi.fn<(...args: any[]) => any>(),
  translateSubtitles: vi.fn<(...args: any[]) => any>(),
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

const PROVIDER_ID = "youtube-probe-provider"

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

// The bridge keeps what a probe switched on until it is put back, across tests as in a session, so
// each test watches a video of its own.
let videoCount = 0
const freshVideoId = () => `vid${String(++videoCount).padStart(8, "0")}`

// The page: YouTube's player, captions off, with the CC button the real bridge presses.
let shownVideoId = ""
let pressed = false
let toggleCaptions: ReturnType<typeof vi.fn<() => void>>

function setPressed(next: boolean) {
  pressed = next
  document.querySelector(".ytp-subtitles-button")?.setAttribute("aria-pressed", String(next))
}

function mountPlayer() {
  document.body.innerHTML =
    '<div class="html5-video-player"><button class="ytp-subtitles-button" aria-pressed="false"></button></div>'
  const player = document.querySelector<HTMLElement>(".html5-video-player") as HTMLElement &
    Record<string, unknown>
  player.getPlayerResponse = () => ({
    videoDetails: { videoId: shownVideoId },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: `/api/timedtext?v=${shownVideoId}&lang=en`,
            languageCode: "en",
            vssId: ".en",
          },
        ],
      },
    },
  })
  player.getAudioTrack = () => ({ captionTracks: [] })
  player.getPlayerState = () => 1
  player.getWebPlayerContextConfig = () => ({})
  // The player reports a selected track only while its captions are on.
  player.getOption = (module: string, option: string) =>
    module === "captions" && option === "track" && pressed
      ? { languageCode: "en", vssId: ".en" }
      : {}
  toggleCaptions = vi.fn<() => void>(() => {
    setPressed(!pressed)
  })
  player.toggleSubtitles = toggleCaptions
}

function setPage(videoId: string) {
  Object.defineProperty(window, "location", {
    value: {
      href: `https://www.youtube.com/watch?v=${videoId}`,
      search: `?v=${videoId}`,
      origin: "https://www.youtube.com",
      pathname: "/watch",
      hostname: "www.youtube.com",
    },
    writable: true,
  })
}

// Everything posted between the content script and the page's bridge, in order.
const posted: Array<{ type?: string; action?: string; requestId?: string }> = []
// Requests of these kinds are kept from the page until released, to land them after a later one.
const heldActions = new Set<string>()
const heldMessages: Array<{ requestId: string; action: string; release: () => void }> = []
const held = (action: string) => heldMessages.filter((message) => message.action === action)

function deliver(data: unknown) {
  setTimeout(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }))
  })
}

// The timed-text file: the next request for it can be kept waiting.
let holdNextFile = false
const heldFiles: Array<() => void> = []

let videoId = ""
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

// The page and the content script both move on to another video.
function navigateTo(next: string) {
  videoId = next
  shownVideoId = next
  setPage(next)
}

beforeAll(() => {
  injectPlayerApi()
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.resolveSubtitlesProviderRef.mockReset()
  mocks.fetchSubtitlesSummary.mockResolvedValue(undefined)
  mocks.getLocalConfig.mockResolvedValue(configFor("kor"))
  pressed = false
  mountPlayer()
  navigateTo(freshVideoId())
  posted.length = 0
  heldActions.clear()
  heldMessages.length = 0
  holdNextFile = false
  heldFiles.length = 0

  // Both ends of the bridge check the origin, which jsdom leaves off a posted message.
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    const message = data as { type?: string; action?: string; requestId?: string }
    posted.push(message)
    if (
      message.type === ENSURE_SUBTITLES_REQUEST_TYPE &&
      message.action &&
      heldActions.has(message.action)
    ) {
      heldMessages.push({
        requestId: message.requestId!,
        action: message.action,
        release: () => deliver(data),
      })
      return
    }
    deliver(data)
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (holdNextFile) {
        holdNextFile = false
        await new Promise<void>((resolve) => heldFiles.push(resolve))
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello there." }] }],
        }),
      }
    }),
  )
  coordinatorStart = vi
    .spyOn(TranslationCoordinator.prototype, "start")
    .mockImplementation(() => undefined)

  adapter = new UniversalVideoAdapter({
    config: {
      selectors: {
        video: "video",
        playerContainer: ".player",
        nativeSubtitles: ".ytp-caption-window-container",
      },
      events: {},
      getVideoId: () => videoId,
    },
    fetchers: { native: () => new YoutubeSubtitlesFetcher() },
  })
  scheduler = newScheduler()
  ;(adapter as any).subtitlesScheduler = scheduler
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.getElementById(HIDE_NATIVE_CAPTIONS_STYLE_ID)?.remove()
  document.body.innerHTML = ""
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const tryAutoStart = () => (adapter as any).tryAutoStartSubtitles() as Promise<void>
// The probe on its own, so a test can wait for it to settle instead of for a timer.
const runProbe = () =>
  (adapter as any).runAutoStart((adapter as any).captureSwitchToken()) as Promise<void>

const requests = (action: string) =>
  posted.filter(
    (message) => message.type === ENSURE_SUBTITLES_REQUEST_TYPE && message.action === action,
  )
const answered = (requestId: string) =>
  posted.some(
    (message) => message.type === ENSURE_SUBTITLES_RESPONSE_TYPE && message.requestId === requestId,
  )

function remount() {
  ;(adapter as any).resetForNavigation()
  scheduler = newScheduler()
  ;(adapter as any).subtitlesScheduler = scheduler
}

describe("probing a YouTube video's language for auto-translate", () => {
  it("leaves the viewer's captions off when the video is already in their language", async () => {
    mocks.getLocalConfig.mockResolvedValue(configFor("eng"))

    await tryAutoStart()

    // The probe switched the captions on to reach the track; declining switches them off again.
    await vi.waitFor(() => expect(toggleCaptions).toHaveBeenCalledTimes(2))
    expect(pressed).toBe(false)
    expect(scheduler.show).not.toHaveBeenCalled()
    expect(coordinatorStart.mock.calls).toHaveLength(0)
  })

  it("leaves the captions on for the translation the probe went on to start", async () => {
    await tryAutoStart()

    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
    expect(requests("restore")).toHaveLength(0)
  })

  it("never switches off captions the viewer already had on", async () => {
    setPressed(true)
    mocks.getLocalConfig.mockResolvedValue(configFor("eng"))

    await tryAutoStart()

    await vi.waitFor(() => expect(requests("restore")).toHaveLength(1))
    await vi.waitFor(() => expect(answered(requests("restore")[0]!.requestId!)).toBe(true))
    expect(toggleCaptions).not.toHaveBeenCalled()
    expect(pressed).toBe(true)
  })

  it("does not let an ensure still queued switch captions on after a switch-off and a remount of the same video", async () => {
    heldActions.add("ensure")
    const probe = runProbe()
    await vi.waitFor(() => expect(held("ensure")).toHaveLength(1))

    adapter.toggleSubtitlesManually(false)
    remount()
    await tryAutoStart()
    // The remount's cancel was posted before this one is released, so it reaches the page first.
    const [queued] = held("ensure")
    queued!.release()
    await vi.waitFor(() => expect(answered(queued!.requestId)).toBe(true))
    await probe

    expect(requests("cancel")).toHaveLength(1)
    expect(toggleCaptions).not.toHaveBeenCalled()
    expect(pressed).toBe(false)
  })

  it("does not let an ensure that waited through a navigation touch the next video's player", async () => {
    heldActions.add("ensure")
    const probe = runProbe()
    await vi.waitFor(() => expect(held("ensure")).toHaveLength(1))

    // Nothing has cleaned up yet: it is the page's own check of the video that has to refuse.
    navigateTo(freshVideoId())
    const [queued] = held("ensure")
    queued!.release()
    await vi.waitFor(() => expect(answered(queued!.requestId)).toBe(true))
    await vi.advanceTimersByTimeAsync(5000)
    await probe

    expect(requests("cancel")).toHaveLength(0)
    expect(requests("restore")).toHaveLength(0)
    expect(toggleCaptions).not.toHaveBeenCalled()
    expect(pressed).toBe(false)
  })

  it("puts the captions back when a remount of the same video gives up a probe that had switched them on", async () => {
    mocks.getLocalConfig.mockResolvedValue(configFor("kor", false))
    holdNextFile = true
    const probe = runProbe()
    await vi.waitFor(() => expect(heldFiles).toHaveLength(1))
    expect(pressed).toBe(true)

    remount()
    await tryAutoStart()
    heldFiles[0]!()
    await vi.advanceTimersByTimeAsync(100)
    await probe

    // The remount gave the probe up, and the page undid what that probe had already changed.
    expect(toggleCaptions).toHaveBeenCalledTimes(2)
    expect(pressed).toBe(false)
    expect(requests("cancel")).toHaveLength(1)
    expect(coordinatorStart.mock.calls).toHaveLength(0)
  })

  it("puts the captions back when a remount gives up a probe that had finished reading but not decided", async () => {
    const settings = deferred<ReturnType<typeof configFor>>()
    // The first read is the fetch's own, the second the probe's, after the captions are in.
    mocks.getLocalConfig
      .mockResolvedValueOnce(configFor("kor"))
      .mockReturnValueOnce(settings.promise)
    const probe = runProbe()
    await vi.waitFor(() => expect(mocks.getLocalConfig).toHaveBeenCalledTimes(2))
    expect(pressed).toBe(true)

    remount()
    settings.resolve(configFor("kor", false))
    await vi.advanceTimersByTimeAsync(100)
    await probe

    expect(requests("cancel")).toHaveLength(1)
    expect(toggleCaptions).toHaveBeenCalledTimes(2)
    expect(pressed).toBe(false)
  })

  it("does not restore captions from under a manual start that began while the probe was reading", async () => {
    holdNextFile = true
    const probe = runProbe()
    await vi.waitFor(() => expect(heldFiles).toHaveLength(1))
    expect(toggleCaptions).toHaveBeenCalledOnce()

    adapter.toggleSubtitlesManually(true)
    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))
    await vi.waitFor(() => expect(requests("claim")).toHaveLength(1))
    heldFiles[0]!()
    await vi.advanceTimersByTimeAsync(100)
    await probe

    // The session took over what the probe changed; the older probe ended without a restore.
    expect(requests("restore")).toHaveLength(0)
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
    expect(coordinatorStart.mock.calls).toHaveLength(1)
  })

  it("leaves no record of the probe once its start is accepted, so the viewer's own captions stay", async () => {
    await tryAutoStart()
    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))
    await vi.waitFor(() => expect(requests("claim")).toHaveLength(1))
    await vi.waitFor(() => expect(answered(requests("claim")[0]!.requestId!)).toBe(true))
    expect(toggleCaptions).toHaveBeenCalledOnce()

    // The viewer uses the captions themselves from here on.
    setPressed(false)
    setPressed(true)
    // The accepted probe's restore, arriving late, finds nothing of its to undo.
    const { operationIds } = requests("claim")[0] as { operationIds: string[] }
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: ENSURE_SUBTITLES_REQUEST_TYPE,
          requestId: "late-restore",
          action: "restore",
          operationId: operationIds[0],
          expectedVideoId: videoId,
        },
      }),
    )
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)

    // A later probe of the same video, finding it already in the viewer's language, declines.
    mocks.getLocalConfig.mockResolvedValue(configFor("eng"))
    remount()
    await tryAutoStart()
    await vi.waitFor(() => expect(requests("restore")).toHaveLength(1))
    await vi.waitFor(() => expect(answered(requests("restore")[0]!.requestId!)).toBe(true))

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })

  it("does not let a restore still on its way switch off the captions of a start that used cached captions", async () => {
    mocks.getLocalConfig.mockResolvedValue(configFor("eng"))
    heldActions.add("restore")
    await tryAutoStart()
    await vi.waitFor(() => expect(held("restore")).toHaveLength(1))
    // The probe switched the captions on to read the track, declined, and its restore is queued.
    expect(pressed).toBe(true)

    // The viewer starts translation on the captions the probe already read: no ensure is sent.
    mocks.getLocalConfig.mockResolvedValue(configFor("kor"))
    adapter.toggleSubtitlesManually(true)
    await vi.waitFor(() => expect(coordinatorStart.mock.calls).toHaveLength(1))
    await vi.waitFor(() => expect(requests("claim")).toHaveLength(1))
    const [queued] = held("restore")
    queued!.release()
    await vi.waitFor(() => expect(answered(queued!.requestId)).toBe(true))

    expect(requests("ensure")).toHaveLength(1)
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })
})
