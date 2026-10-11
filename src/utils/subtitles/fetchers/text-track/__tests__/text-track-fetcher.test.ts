import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  TEXT_TRACK_CUE_POLL_INTERVAL_MS,
  TEXT_TRACK_NATIVE_REHIDE_DELAY_MS,
} from "@/utils/constants/subtitles"
import { TextTrackFetcher } from ".."

vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))

class FakeTrack extends EventTarget {
  cues: ArrayLike<TextTrackCue> | null = null

  constructor(
    public kind: string,
    public label: string,
    public language: string,
    public mode: string,
  ) {
    super()
  }

  loadCues(...texts: string[]) {
    this.cues = texts.map((text, index) => ({
      startTime: index,
      endTime: index + 1,
      text,
    })) as unknown as TextTrackCue[]
  }
}

type FakeTrackList = FakeTrack[] & {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
  emit: (type: string) => void
}

function trackListOf(tracks: FakeTrack[]): FakeTrackList {
  const listeners = new Map<string, Set<() => void>>()
  return Object.assign(tracks, {
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  })
}

function videoWith(...tracks: FakeTrack[]): HTMLVideoElement {
  return { textTracks: trackListOf(tracks) } as unknown as HTMLVideoElement
}

function createFetcher(video: HTMLVideoElement | null, videoId = "1") {
  return new TextTrackFetcher({ resolveVideo: () => video, getVideoId: () => videoId })
}

describe("TextTrackFetcher", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("prefers the showing subtitle track and flips disabled tracks to hidden to load cues", async () => {
    const english = new FakeTrack("subtitles", "English", "en", "disabled")
    const japanese = new FakeTrack("subtitles", "日本語", "ja", "showing")
    japanese.loadCues("こんにちは")
    const fetcher = createFetcher(videoWith(english, japanese))

    await expect(fetcher.fetch()).resolves.toEqual([{ text: "こんにちは", start: 0, end: 1000 }])
    expect(fetcher.getSourceLanguage()).toBe("ja")
    expect(english.mode).toBe("disabled")

    japanese.mode = "disabled"
    english.loadCues("hello")
    await createFetcher(videoWith(english, japanese)).hasAvailableSubtitles()
    expect(english.mode).toBe("hidden")
  })

  it("waits for cues that load after the request", async () => {
    const track = new FakeTrack("subtitles", "English", "en", "hidden")
    const pending = createFetcher(videoWith(track)).fetch()

    track.loadCues("late")
    await vi.advanceTimersByTimeAsync(TEXT_TRACK_CUE_POLL_INTERVAL_MS)

    await expect(pending).resolves.toEqual([{ text: "late", start: 0, end: 1000 }])
  })

  it("reuses the same track until the video changes", async () => {
    const track = new FakeTrack("subtitles", "English", "en", "showing")
    track.loadCues("hello")
    let videoId = "1"
    const fetcher = new TextTrackFetcher({
      resolveVideo: () => videoWith(track),
      getVideoId: () => videoId,
    })

    await fetcher.fetch()
    await expect(fetcher.shouldUseSameTrack()).resolves.toBe(true)

    videoId = "2"
    await expect(fetcher.shouldUseSameTrack()).resolves.toBe(false)
  })

  it("keeps hiding captions the player reveals after we hid them", () => {
    const track = new FakeTrack("subtitles", "English", "en", "disabled")
    const video = videoWith(track)
    const tracks = video.textTracks as unknown as FakeTrackList
    const fetcher = createFetcher(video)

    fetcher.hideNativeSubtitles()
    vi.advanceTimersByTime(TEXT_TRACK_NATIVE_REHIDE_DELAY_MS)

    track.mode = "showing"
    tracks.emit("change")
    expect(track.mode).toBe("hidden")

    fetcher.showNativeSubtitles()
    track.mode = "showing"
    tracks.emit("change")
    expect(track.mode).toBe("showing")
  })

  it("lets the caller exclude tracks from selection", async () => {
    const real = new FakeTrack("subtitles", "English.srt", "EN", "hidden")
    real.loadCues("hello")
    const render = new FakeTrack("captions", "render", "", "showing")
    render.loadCues("partial")

    const fetcher = new TextTrackFetcher({
      resolveVideo: () => videoWith(render, real),
      getVideoId: () => "1",
      isSourceTrack: (track) => track.label !== "render",
    })

    await expect(fetcher.fetch()).resolves.toEqual([{ text: "hello", start: 0, end: 1000 }])
  })

  it("restores the mode the player last asked for, not the one it had first", () => {
    const track = new FakeTrack("captions", "English", "en", "showing")
    const video = videoWith(track)
    const tracks = video.textTracks as unknown as FakeTrackList
    const fetcher = createFetcher(video)

    fetcher.hideNativeSubtitles()
    track.mode = "disabled"
    tracks.emit("change")
    fetcher.showNativeSubtitles()

    expect(track.mode).toBe("disabled")
  })

  it("hides showing tracks, re-applies after the player flips them back, and restores on show", () => {
    const track = new FakeTrack("subtitles", "English", "en", "showing")
    const fetcher = createFetcher(videoWith(track))

    fetcher.hideNativeSubtitles()
    expect(track.mode).toBe("hidden")

    track.mode = "showing"
    vi.advanceTimersByTime(TEXT_TRACK_NATIVE_REHIDE_DELAY_MS)
    expect(track.mode).toBe("hidden")

    fetcher.showNativeSubtitles()
    expect(track.mode).toBe("showing")
  })

  it("rejects when the video has no subtitle tracks", async () => {
    const fetcher = createFetcher(videoWith(new FakeTrack("metadata", "", "", "hidden")))

    await expect(fetcher.hasAvailableSubtitles()).resolves.toBe(false)
    await expect(fetcher.fetch()).rejects.toThrow("subtitles.errors.noSubtitlesFound")
  })

  it.each([true, false])(
    "selects the player's replacement track after hiding (old track disabled: %s)",
    async (disableOld) => {
      const first = new FakeTrack("subtitles", "English", "en", "showing")
      const second = new FakeTrack("subtitles", "Japanese", "ja", "disabled")
      first.loadCues("first")
      second.loadCues("second")
      const video = videoWith(first, second)
      const tracks = video.textTracks as unknown as FakeTrackList
      const fetcher = createFetcher(video)
      fetcher.hideNativeSubtitles()
      await fetcher.fetch()

      first.mode = disableOld ? "disabled" : "hidden"
      second.mode = "showing"
      tracks.emit("change")
      expect(second.mode).toBe("hidden")
      await expect(fetcher.shouldUseSameTrack()).resolves.toBe(false)
      await expect(fetcher.fetch()).resolves.toEqual([{ text: "second", start: 0, end: 1000 }])
      fetcher.showNativeSubtitles()
      expect(first.mode).toBe(disableOld ? "disabled" : "hidden")
      expect(second.mode).toBe("showing")
    },
  )

  it("does not let an old fetch mutate the replacement track cache after cleanup", async () => {
    const first = new FakeTrack("subtitles", "English", "en", "showing")
    const second = new FakeTrack("subtitles", "Japanese", "ja", "disabled")
    second.loadCues("second")
    const video = videoWith(first, second)
    const fetcher = createFetcher(video)
    const oldFetch = fetcher.fetch().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    fetcher.cleanup()
    first.mode = "disabled"
    second.mode = "showing"
    await expect(fetcher.fetch()).resolves.toEqual([{ text: "second", start: 0, end: 1000 }])

    first.loadCues("first")
    await vi.advanceTimersByTimeAsync(TEXT_TRACK_CUE_POLL_INTERVAL_MS)
    const oldResult = await oldFetch
    expect(oldResult).toBeInstanceOf(DOMException)
    expect((oldResult as DOMException).name).toBe("AbortError")
    expect(fetcher.getSourceLanguage()).toBe("ja")
    await expect(fetcher.shouldUseSameTrack()).resolves.toBe(true)
    await expect(fetcher.fetch()).resolves.toEqual([{ text: "second", start: 0, end: 1000 }])
  })

  it("distinguishes two native tracks with equal metadata and different cues", async () => {
    const first = new FakeTrack("subtitles", "English", "en", "showing")
    const second = new FakeTrack("subtitles", "English", "en", "disabled")
    first.loadCues("first")
    second.loadCues("second")
    const fetcher = createFetcher(videoWith(first, second))
    await fetcher.fetch()
    first.mode = "disabled"
    second.mode = "showing"
    await expect(fetcher.shouldUseSameTrack()).resolves.toBe(false)
    await expect(fetcher.fetch()).resolves.toEqual([{ text: "second", start: 0, end: 1000 }])
  })

  it("does not reactivate the old hidden track while restarting after the player shows only B", async () => {
    const first = new FakeTrack("subtitles", "English", "en", "showing")
    const second = new FakeTrack("subtitles", "Japanese", "ja", "disabled")
    first.loadCues("first")
    second.loadCues("second")
    const video = videoWith(first, second)
    const tracks = video.textTracks as unknown as FakeTrackList
    const fetcher = createFetcher(video)
    fetcher.hideNativeSubtitles()
    await fetcher.fetch()
    second.mode = "showing"
    tracks.emit("change")
    fetcher.cleanup()
    expect(first.mode).toBe("hidden")
    expect(second.mode).toBe("showing")
    fetcher.hideNativeSubtitles()
    await expect(fetcher.fetch()).resolves.toEqual([{ text: "second", start: 0, end: 1000 }])
  })

  it("preserves an initial explicit multiple-showing-track state when no replacement selection occurs", () => {
    const first = new FakeTrack("subtitles", "English", "en", "showing")
    const second = new FakeTrack("subtitles", "Japanese", "ja", "showing")
    const fetcher = createFetcher(videoWith(first, second))
    fetcher.hideNativeSubtitles()
    fetcher.cleanup()
    expect(first.mode).toBe("showing")
    expect(second.mode).toBe("showing")
  })

  it("restores a selection back to A when the late hiding timer observes it without a change event", () => {
    const first = new FakeTrack("subtitles", "English", "en", "showing")
    const second = new FakeTrack("subtitles", "Japanese", "ja", "disabled")
    const video = videoWith(first, second)
    const tracks = video.textTracks as unknown as FakeTrackList
    const fetcher = createFetcher(video)
    fetcher.hideNativeSubtitles()
    second.mode = "showing"
    tracks.emit("change")
    first.mode = "showing"
    vi.advanceTimersByTime(TEXT_TRACK_NATIVE_REHIDE_DELAY_MS)
    fetcher.showNativeSubtitles()
    expect(first.mode).toBe("showing")
    expect(second.mode).toBe("hidden")
  })
})
