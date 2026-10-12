import { afterEach, describe, expect, it } from "vitest"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  adPlayingAtom,
  currentSubtitleAtom,
  currentTimeMsAtom,
  displaySubtitleAtom,
  nativeSubtitleTranslationBlockedAtom,
  sourceTrackAtom,
  subtitlesShowContentAtom,
  subtitlesShowStateAtom,
  subtitlesStateAtom,
  subtitlesStore,
  subtitlesVisibleAtom,
} from "../atoms"

describe("displaySubtitleAtom", () => {
  afterEach(() => {
    subtitlesStore.set(adPlayingAtom, false)
    subtitlesStore.set(currentSubtitleAtom, null)
    subtitlesStore.set(sourceTrackAtom, [])
    subtitlesStore.set(subtitlesStateAtom, null)
    subtitlesStore.set(subtitlesVisibleAtom, false)
    subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
    subtitlesStore.set(configAtom, DEFAULT_CONFIG)
  })

  it("falls back to source track when no translated cue is scheduled", () => {
    subtitlesStore.set(currentTimeMsAtom, 500)
    subtitlesStore.set(currentSubtitleAtom, null)
    subtitlesStore.set(sourceTrackAtom, [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 1000, end: 2000 },
    ])

    expect(subtitlesStore.get(displaySubtitleAtom)).toEqual({
      text: "hello",
      start: 0,
      end: 1000,
    })
  })

  it("prefers the translated scheduler cue when present", () => {
    subtitlesStore.set(currentTimeMsAtom, 500)
    subtitlesStore.set(sourceTrackAtom, [{ text: "hello", start: 0, end: 1000 }])
    subtitlesStore.set(currentSubtitleAtom, {
      text: "hello",
      start: 0,
      end: 1000,
      translation: "你好",
    })

    expect(subtitlesStore.get(displaySubtitleAtom)?.translation).toBe("你好")
  })

  it("ignores a stale scheduled cue that no longer covers the current time", () => {
    subtitlesStore.set(currentTimeMsAtom, 2500)
    subtitlesStore.set(sourceTrackAtom, [
      { text: "hello", start: 0, end: 1000 },
      { text: "later", start: 2000, end: 3000 },
    ])
    // Scheduler atom lagging behind the clock.
    subtitlesStore.set(currentSubtitleAtom, {
      text: "hello",
      start: 0,
      end: 1000,
      translation: "你好",
    })

    expect(subtitlesStore.get(displaySubtitleAtom)).toEqual({
      text: "later",
      start: 2000,
      end: 3000,
    })
  })

  it("does not render a stale scheduled translation in translation-only mode", () => {
    subtitlesStore.set(configAtom, {
      ...DEFAULT_CONFIG,
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        style: {
          ...DEFAULT_CONFIG.videoSubtitles.style,
          displayMode: "translationOnly",
        },
      },
    })
    subtitlesStore.set(currentTimeMsAtom, 2500)
    subtitlesStore.set(subtitlesStateAtom, { state: "loading" })
    subtitlesStore.set(subtitlesVisibleAtom, true)
    subtitlesStore.set(sourceTrackAtom, [{ text: "later", start: 2000, end: 3000 }])
    subtitlesStore.set(currentSubtitleAtom, {
      text: "hello",
      start: 0,
      end: 1000,
      translation: "你好",
    })

    expect(subtitlesStore.get(displaySubtitleAtom)).toEqual({
      text: "later",
      start: 2000,
      end: 3000,
    })
    expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(false)
    expect(subtitlesStore.get(subtitlesShowStateAtom)).toBe("loading")
  })

  it("hides main-video captions while an ad is playing", () => {
    subtitlesStore.set(currentTimeMsAtom, 500)
    subtitlesStore.set(subtitlesVisibleAtom, true)
    subtitlesStore.set(sourceTrackAtom, [{ text: "hello", start: 0, end: 1000 }])
    subtitlesStore.set(currentSubtitleAtom, {
      text: "hello",
      start: 0,
      end: 1000,
      translation: "你好",
    })
    subtitlesStore.set(adPlayingAtom, true)

    expect(subtitlesStore.get(displaySubtitleAtom)).toBeNull()
    expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(false)
    // User toggle intent stays on.
    expect(subtitlesStore.get(subtitlesVisibleAtom)).toBe(true)
  })

  describe("after a start with no provider to translate with", () => {
    function showOriginalOnly(displayMode: "bilingual" | "originalOnly" | "translationOnly") {
      subtitlesStore.set(configAtom, {
        ...DEFAULT_CONFIG,
        videoSubtitles: {
          ...DEFAULT_CONFIG.videoSubtitles,
          style: { ...DEFAULT_CONFIG.videoSubtitles.style, displayMode },
        },
      })
      subtitlesStore.set(currentTimeMsAtom, 500)
      subtitlesStore.set(subtitlesVisibleAtom, true)
      subtitlesStore.set(sourceTrackAtom, [{ text: "hello", start: 0, end: 1000 }])
      subtitlesStore.set(subtitlesStateAtom, { state: "idle" })
    }

    it.each(["bilingual", "originalOnly"] as const)(
      "keeps showing the original in %s mode, with no loading",
      (displayMode) => {
        showOriginalOnly(displayMode)
        subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, true)

        expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(true)
        expect(subtitlesStore.get(subtitlesShowStateAtom)).toBeUndefined()
        expect(subtitlesStore.get(displaySubtitleAtom)).toEqual({
          text: "hello",
          start: 0,
          end: 1000,
        })
      },
    )

    it("shows no loading and never passes the original off as the translation in translation-only mode", () => {
      showOriginalOnly("translationOnly")
      // Without a refusal a cue still waiting for its translation is "loading", as before.
      expect(subtitlesStore.get(subtitlesShowStateAtom)).toBe("loading")

      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, true)

      expect(subtitlesStore.get(subtitlesShowStateAtom)).toBeUndefined()
      expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(false)
    })

    it("follows live display-mode changes on the same original cue without inventing a translation", () => {
      // What an original-only start with no provider leaves behind: the source cue, no translation.
      showOriginalOnly("originalOnly")
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, true)
      const setDisplayMode = (displayMode: "bilingual" | "originalOnly" | "translationOnly") =>
        subtitlesStore.set(configAtom, {
          ...DEFAULT_CONFIG,
          videoSubtitles: {
            ...DEFAULT_CONFIG.videoSubtitles,
            style: { ...DEFAULT_CONFIG.videoSubtitles.style, displayMode },
          },
        })

      expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(true)
      expect(subtitlesStore.get(subtitlesShowStateAtom)).toBeUndefined()

      setDisplayMode("translationOnly")
      // The original is not passed off as the translation, and nothing is loading.
      expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(false)
      expect(subtitlesStore.get(subtitlesShowStateAtom)).toBeUndefined()

      setDisplayMode("bilingual")
      expect(subtitlesStore.get(subtitlesShowContentAtom)).toBe(true)
      expect(subtitlesStore.get(subtitlesShowStateAtom)).toBeUndefined()
      expect(subtitlesStore.get(displaySubtitleAtom)).toEqual({
        text: "hello",
        start: 0,
        end: 1000,
      })
      expect(subtitlesStore.get(displaySubtitleAtom)?.translation).toBeUndefined()
    })

    it("still reports an error", () => {
      showOriginalOnly("bilingual")
      subtitlesStore.set(subtitlesStateAtom, { state: "error", message: "boom" })
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, true)

      expect(subtitlesStore.get(subtitlesShowStateAtom)).toBe("error")
    })
  })
})
