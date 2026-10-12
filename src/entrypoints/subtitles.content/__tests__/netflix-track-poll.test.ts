// @vitest-environment jsdom

import type { NetflixSubtitlesResponse } from "@/utils/subtitles/fetchers/netflix"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NetflixSubtitlesFetcher } from "@/utils/subtitles/fetchers/netflix"
import { showSubtitlesErrorToast } from "@/utils/subtitles/toast"
import {
  sourceTrackAtom,
  sourceSubtitlesCopyStatusAtom,
  translatedSubtitlesCopyStatusAtom,
  SubtitleCopyPhase,
  subtitlesStore,
} from "../atoms"
import { UniversalVideoAdapter } from "../universal-adapter"

const page = vi.hoisted(() => ({
  answer: (_action: string): Promise<unknown> => Promise.resolve(null),
}))
const postMessageRequest = vi.hoisted(() =>
  vi.fn<(type: string, message: { action: string }) => Promise<unknown>>((_type, message) =>
    page.answer(message.action),
  ),
)
vi.mock("@/utils/subtitles/fetchers/post-message-request", () => ({ postMessageRequest }))
vi.mock("@/utils/subtitles/toast", () => ({
  showSubtitlesErrorToast: vi.fn<(message: string) => void>(),
  showAiSubtitlesWallToast: vi.fn<() => void>(),
}))

vi.mock("@/utils/config/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/config/storage")>()),
  getLocalConfig: async () => ({
    language: {},
    providersConfig: [],
    videoSubtitles: { aiSegmentation: false, providerId: null },
  }),
}))

// What the page script reports: the selected track, whose subtitle file it never captured.
function pageReply(overrides: Partial<NetflixSubtitlesResponse> = {}): NetflixSubtitlesResponse {
  return {
    type: "response",
    requestId: "1",
    movieId: 1,
    trackId: "T:en",
    translatable: true,
    ttml: null,
    ...overrides,
  }
}

function loadRequests() {
  return postMessageRequest.mock.calls.filter(([, message]) => message.action === "load").length
}

// Subtitles are on, so every Netflix poll tick reaches the fetcher's track check.
function createNetflixAdapter(active = true) {
  const fetcher = new NetflixSubtitlesFetcher()
  const adapter = new UniversalVideoAdapter({
    config: { selectors: { video: "video", playerContainer: ".player" }, events: {} },
    fetchers: { native: () => fetcher },
  })
  const scheduler = {
    isActive: () => active,
    reset: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    setState: vi.fn<(state: string, data?: { message?: string }) => void>(),
    supplementSubtitles: vi.fn<() => void>(),
    getVideoElement: () => ({ currentTime: 0 }),
    getState: () => "idle",
  }
  ;(adapter as any).subtitlesScheduler = scheduler
  return { adapter, scheduler, fetcher }
}

describe("Netflix track poll", () => {
  beforeEach(() => {
    postMessageRequest.mockClear()
    vi.mocked(showSubtitlesErrorToast).mockClear()
    subtitlesStore.set(sourceTrackAtom, [])
    subtitlesStore.set(sourceSubtitlesCopyStatusAtom, {
      phase: SubtitleCopyPhase.Idle,
      progress: null,
    })
    subtitlesStore.set(translatedSubtitlesCopyStatusAtom, {
      phase: SubtitleCopyPhase.Idle,
      progress: null,
    })
  })

  it("leaves a failed load's error on screen while the same track stays selected", async () => {
    page.answer = async () => pageReply()
    const { adapter, scheduler } = createNetflixAdapter()
    await (adapter as any).startTranslation()
    expect(scheduler.setState).toHaveBeenLastCalledWith("error", {
      message: "subtitles.errors.trackFileNotLoaded",
    })
    scheduler.reset.mockClear()
    scheduler.setState.mockClear()

    await adapter.handleSourceTrackChanged()
    await adapter.handleSourceTrackChanged()

    expect(scheduler.reset).not.toHaveBeenCalled()
    expect(scheduler.setState).not.toHaveBeenCalled()
    expect(loadRequests()).toBe(1)
  })

  it("loads again after a failure once the viewer picks another track", async () => {
    page.answer = async () => pageReply()
    const { adapter, scheduler } = createNetflixAdapter()
    await (adapter as any).startTranslation()

    page.answer = async () => pageReply({ trackId: "T:ja" })
    await adapter.handleSourceTrackChanged()

    expect(scheduler.setState).toHaveBeenCalledWith("loading")
    expect(loadRequests()).toBe(2)
  })

  it("lets a load that is still running finish instead of starting another", async () => {
    let finishLoad!: (reply: NetflixSubtitlesResponse) => void
    const firstLoad = new Promise<NetflixSubtitlesResponse>((resolve) => {
      finishLoad = resolve
    })
    let loads = 0
    page.answer = (action) =>
      action === "load" && ++loads === 1 ? firstLoad : Promise.resolve(pageReply())
    const { adapter, scheduler } = createNetflixAdapter()
    const starting = (adapter as any).startTranslation()
    await vi.waitFor(() => expect(loadRequests()).toBe(1))
    scheduler.reset.mockClear()

    await adapter.handleSourceTrackChanged()

    expect(scheduler.reset).not.toHaveBeenCalled()
    expect(loadRequests()).toBe(1)

    finishLoad(pageReply())
    await starting
  })

  it.each([false, true])(
    "does not retry a failed transcript refresh on unchanged polls (state unavailable: %s)",
    async (stateUnavailable) => {
      page.answer = async () =>
        pageReply({ ttml: '<tt><body><p begin="10000000t" end="20000000t">A</p></body></tt>' })
      const { adapter, scheduler } = createNetflixAdapter(false)
      await adapter.ensureSourceTrackPublished()
      expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["A"])

      page.answer = async () => pageReply({ trackId: "T:ja" })
      await adapter.handleSourceTrackChanged()
      expect(loadRequests()).toBe(2)
      expect(subtitlesStore.get(sourceTrackAtom)).toEqual([])
      expect(showSubtitlesErrorToast).toHaveBeenCalledTimes(1)
      scheduler.reset.mockClear()
      if (stateUnavailable)
        page.answer = async (action) => (action === "state" ? null : pageReply({ trackId: "T:ja" }))

      await adapter.handleSourceTrackChanged()
      await adapter.handleSourceTrackChanged()

      expect(loadRequests()).toBe(2)
      expect(showSubtitlesErrorToast).toHaveBeenCalledTimes(1)
      expect(scheduler.reset).not.toHaveBeenCalled()
    },
  )

  it("does not duplicate a user's pending copy load after a failed transcript refresh", async () => {
    page.answer = async () =>
      pageReply({ ttml: '<tt><body><p begin="10000000t" end="20000000t">A</p></body></tt>' })
    const { adapter } = createNetflixAdapter(false)
    await adapter.ensureSourceTrackPublished()
    page.answer = async () => pageReply({ trackId: "T:ja" })
    await adapter.handleSourceTrackChanged()

    let finishLoad!: (reply: NetflixSubtitlesResponse) => void
    const pendingLoad = new Promise<NetflixSubtitlesResponse>((resolve) => {
      finishLoad = resolve
    })
    page.answer = (action) =>
      action === "load" ? pendingLoad : Promise.resolve(pageReply({ trackId: "T:ja" }))
    const preparing = adapter.copySourceSubtitles()
    await vi.waitFor(() => expect(loadRequests()).toBe(3))
    const polling = adapter.handleSourceTrackChanged()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const requestsWhilePending = loadRequests()
    finishLoad(
      pageReply({
        trackId: "T:ja",
        ttml: '<tt><body><p begin="10000000t" end="20000000t">B</p></body></tt>',
      }),
    )
    await Promise.all([preparing, polling])

    expect(requestsWhilePending).toBe(3)
    expect(loadRequests()).toBe(3)
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Ready)
    await adapter.handleSourceTrackChanged()
    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["B"])
    expect(loadRequests()).toBe(3)
  })

  it.each(["track", "episode"])("recovers a failed transcript after a new %s", async (change) => {
    page.answer = async () =>
      pageReply({ ttml: '<tt><body><p begin="10000000t" end="20000000t">A</p></body></tt>' })
    const { adapter } = createNetflixAdapter(false)
    await adapter.ensureSourceTrackPublished()
    page.answer = async () => pageReply({ trackId: "T:ja" })
    await adapter.handleSourceTrackChanged()

    page.answer = async () =>
      pageReply({
        movieId: change === "episode" ? 2 : 1,
        trackId: change === "track" ? "T:ko" : "T:ja",
        ttml: '<tt><body><p begin="10000000t" end="20000000t">C</p></body></tt>',
      })
    await adapter.handleSourceTrackChanged()
    await adapter.handleSourceTrackChanged()

    expect(loadRequests()).toBe(3)
    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["C"])
    expect(showSubtitlesErrorToast).toHaveBeenCalledTimes(1)
  })

  it("republishes a successful shared cache after a failed refresh without starting another load", async () => {
    page.answer = async () =>
      pageReply({ ttml: '<tt><body><p begin="10000000t" end="20000000t">A</p></body></tt>' })
    const { adapter, fetcher } = createNetflixAdapter(false)
    await adapter.ensureSourceTrackPublished()
    page.answer = async () => pageReply({ trackId: "T:ja" })
    await adapter.handleSourceTrackChanged()

    // Translated export uses this shared fetcher without filling the adapter's source cache.
    page.answer = async () =>
      pageReply({
        trackId: "T:ja",
        ttml: '<tt><body><p begin="10000000t" end="20000000t">B</p></body></tt>',
      })
    await fetcher.fetch()
    subtitlesStore.set(translatedSubtitlesCopyStatusAtom, {
      phase: SubtitleCopyPhase.Ready,
      progress: null,
    })
    await adapter.handleSourceTrackChanged()

    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["B"])
    expect(subtitlesStore.get(translatedSubtitlesCopyStatusAtom).phase).toBe(
      SubtitleCopyPhase.Ready,
    )
    expect(loadRequests()).toBe(3)
  })

  it.each([
    { cache: "shared", state: "missing" },
    { cache: "shared", state: "malformed" },
    { cache: "adapter", state: "missing" },
  ])("does not republish $cache cache after a $state state reply", async ({ cache, state }) => {
    page.answer = async () =>
      pageReply({ ttml: '<tt><body><p begin="10000000t" end="20000000t">A</p></body></tt>' })
    const { adapter, fetcher } = createNetflixAdapter(false)
    await adapter.ensureSourceTrackPublished()
    page.answer = async () => pageReply({ trackId: "T:ja" })
    await adapter.handleSourceTrackChanged()
    page.answer = async () =>
      pageReply({
        trackId: "T:ja",
        ttml: '<tt><body><p begin="10000000t" end="20000000t">B</p></body></tt>',
      })
    if (cache === "adapter") await adapter.copySourceSubtitles()
    else await fetcher.fetch()

    const selectedC = pageReply({
      trackId: "T:ko",
      ttml: '<tt><body><p begin="10000000t" end="20000000t">C</p></body></tt>',
    })
    const unknownState = state === "missing" ? null : { ...selectedC, movieId: "invalid" }
    page.answer = async (action) => (action === "state" ? unknownState : selectedC)
    await adapter.handleSourceTrackChanged()
    await adapter.handleSourceTrackChanged()

    expect(subtitlesStore.get(sourceTrackAtom)).toEqual([])
    expect(loadRequests()).toBe(3)
    expect(showSubtitlesErrorToast).toHaveBeenCalledTimes(1)

    page.answer = async () => selectedC
    await adapter.handleSourceTrackChanged()
    expect(subtitlesStore.get(sourceTrackAtom).map((cue) => cue.text)).toEqual(["C"])
    expect(loadRequests()).toBe(4)
  })
})
