// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://x.com/fixture/status/1234567890"}
import type { ContentScriptContext } from "#imports"
import type { Config } from "@/types/config/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { XCOM_STATUS_POLL_INTERVAL_MS } from "@/utils/constants/subtitles"
import { TextTrackFetcher } from "@/utils/subtitles/fetchers/text-track"
import {
  sourceSubtitlesCopyStatusAtom,
  sourceTrackAtom,
  subtitlesStore,
  SubtitleCopyPhase,
  translatedSubtitlesCopyStatusAtom,
} from "../atoms"
import { initXcomSubtitles } from "../init-xcom-subtitles"
import { UniversalVideoAdapter } from "../universal-adapter"

const fixture = vi.hoisted(() => ({
  adapter: null as UniversalVideoAdapter | null,
  video: null as HTMLVideoElement | null,
  container: null as HTMLElement | null,
  videoId: "1234567890",
  targetCode: "kor" as Config["language"]["targetCode"],
  fetcher: null as TextTrackFetcher | null,
  cleanup: [] as Array<() => void>,
}))
vi.mock("../platforms/xcom", () => ({ createXcomSubtitlesAdapter: () => fixture.adapter }))
vi.mock("../platforms/xcom/config", () => ({
  getXcomConfig: () => ({
    selectors: { video: "video", playerContainer: ".fixture-player" },
    events: {},
    getVideoId: () => fixture.videoId,
  }),
}))
vi.mock("../platforms/xcom/dom", () => ({
  getCurrentPrimaryXcomStatusVideo: () => fixture.video,
  getCurrentXcomVideoId: () => fixture.videoId,
  getXcomStatusVideoContainer: () => fixture.container,
}))
vi.mock("../platforms/xcom/overlay-entry", () => ({
  clearXcomOverlayEntryPoints: () => {},
  ensureXcomOverlayEntryPoint: () => !!fixture.container,
  mountXcomTranslateButton: () => {},
}))
vi.mock("../platforms/xcom/watch-player", () => ({ watchXcomPlayer: () => () => {} }))
vi.mock("../renderer/mount-subtitles-sidebar", () => ({ mountSubtitlesSidebar: () => {} }))
vi.mock("../renderer/mount-subtitles-ui", () => ({
  mountSubtitlesUI: async () => {},
  unmountSubtitlesUI: () => {},
}))
vi.mock("../bind-subtitles-toggle-shortcut", () => ({
  bindSubtitlesToggleShortcut: async () => () => {},
}))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: () => {} } }))
vi.mock("@/utils/config/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/config/storage")>()),
  getLocalConfig: async () => ({
    ...DEFAULT_CONFIG,
    language: { ...DEFAULT_CONFIG.language, sourceCode: "eng", targetCode: fixture.targetCode },
    providersConfig: [DEFAULT_PROVIDER_CONFIG.openai],
    videoSubtitles: {
      ...DEFAULT_CONFIG.videoSubtitles,
      providerId: DEFAULT_PROVIDER_CONFIG.openai.id,
      aiSegmentation: false,
    },
  }),
}))
vi.mock("@/utils/subtitles/processor/translator", () => ({
  buildSubtitlesSummaryContextHash: () => "fixture-summary",
  fetchSubtitlesSummary: async () => null,
  resolveSubtitlesProviderRef: async () => ({
    kind: "local",
    config: DEFAULT_PROVIDER_CONFIG.openai,
  }),
  translateSubtitles: async (
    fragments: Array<{ text: string; start: number; end: number }>,
    _context: unknown,
    config: Config,
  ) =>
    fragments.map((fragment) => ({
      ...fragment,
      translation: `${config.language.targetCode}:${fragment.text}`,
    })),
}))

function setup() {
  const video = document.createElement("video")
  const first = {
    kind: "subtitles",
    label: "Fixture English",
    language: "en",
    mode: "showing",
    cues: [{ text: "First track.", startTime: 0, endTime: 2 }],
  }
  const second = {
    kind: "subtitles",
    label: "Fixture Japanese",
    language: "ja",
    mode: "disabled",
    cues: [{ text: "Next track.", startTime: 3, endTime: 5 }],
  }
  const trackEvents = new EventTarget()
  const tracks = Object.assign([first, second], {
    addEventListener: trackEvents.addEventListener.bind(trackEvents),
    removeEventListener: trackEvents.removeEventListener.bind(trackEvents),
  })
  Object.defineProperty(video, "textTracks", { value: tracks })
  fixture.video = video
  fixture.container = document.createElement("div")
  fixture.videoId = "1234567890"
  const fetcher = new TextTrackFetcher({
    resolveVideo: () => video,
    getVideoId: () => fixture.videoId,
  })
  fixture.fetcher = fetcher
  const adapter = new UniversalVideoAdapter({
    config: {
      selectors: { video: "video", playerContainer: ".fixture-player" },
      events: {},
      getVideoId: () => fixture.videoId,
    },
    fetchers: {
      native: () => fetcher,
    },
  })
  // Only renderer/scheduler setup is skipped. Track selection, fetching, copying and
  // initializer polling below run through their actual production implementations.
  vi.spyOn(adapter, "initialize").mockResolvedValue(undefined)
  fixture.adapter = adapter
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  initXcomSubtitles({
    onInvalidated: (cleanup: () => void) => {
      fixture.cleanup.push(cleanup)
      return () => {
        fixture.cleanup = fixture.cleanup.filter((registered) => registered !== cleanup)
      }
    },
  } as ContentScriptContext)
  return {
    adapter,
    fetcher,
    first,
    video,
    emitTrackChange: () => trackEvents.dispatchEvent(new Event("change")),
    writeText,
    selectNextTrack: () => {
      first.mode = "disabled"
      second.mode = "showing"
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  fixture.targetCode = "kor"
  subtitlesStore.set(configAtom, {
    ...DEFAULT_CONFIG,
    language: { ...DEFAULT_CONFIG.language, sourceCode: "eng", targetCode: fixture.targetCode },
  })
  subtitlesStore.set(sourceTrackAtom, [])
  for (const atom of [sourceSubtitlesCopyStatusAtom, translatedSubtitlesCopyStatusAtom]) {
    subtitlesStore.set(atom, { phase: SubtitleCopyPhase.Idle, progress: null })
  }
})
afterEach(() => {
  fixture.fetcher?.cleanup()
  for (const cleanup of fixture.cleanup.splice(0)) cleanup()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("x.com same-video subtitle track selection", () => {
  it("preserves ready source text on unchanged polls, then invalidates it after track selection", async () => {
    const { adapter, selectNextTrack, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copySourceSubtitles()
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Ready)
    selectNextTrack()
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Idle)
    expect(writeText).not.toHaveBeenCalled()
  })

  it("prepares the new source track instead of copying the old ready text", async () => {
    const { adapter, selectNextTrack, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copySourceSubtitles()
    selectNextTrack()
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    await adapter.copySourceSubtitles()
    expect(writeText).not.toHaveBeenCalled()
    await adapter.copySourceSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:03,000 --> 00:00:05,000\nNext track.")
  })

  it("invalidates a prepared translated export when the same-video source track changes", async () => {
    const { adapter, selectNextTrack, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copyTranslatedSubtitles()
    expect(subtitlesStore.get(translatedSubtitlesCopyStatusAtom).phase).toBe(
      SubtitleCopyPhase.Ready,
    )
    selectNextTrack()
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    expect(subtitlesStore.get(translatedSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Idle)
    expect(writeText).not.toHaveBeenCalled()
  })

  it("does not copy translated track A after source preparation caches track B before polling", async () => {
    const { adapter, selectNextTrack, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copyTranslatedSubtitles()
    selectNextTrack()
    await adapter.copySourceSubtitles()
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    await adapter.copyTranslatedSubtitles()
    expect(writeText).not.toHaveBeenCalled()
    await adapter.copyTranslatedSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:03,000 --> 00:00:05,000\nkor:Next track.")
  })

  it("preserves prepared translated text when source preparation uses the unchanged track", async () => {
    const { adapter, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copyTranslatedSubtitles()
    await adapter.copySourceSubtitles()
    expect(subtitlesStore.get(translatedSubtitlesCopyStatusAtom).phase).toBe(
      SubtitleCopyPhase.Ready,
    )
    const copied = adapter.copyTranslatedSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:00,000 --> 00:00:02,000\nkor:First track.")
    await copied
  })

  it("does not copy source track A after translated preparation caches track B before polling", async () => {
    const { adapter, selectNextTrack, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copySourceSubtitles()
    selectNextTrack()
    await adapter.copyTranslatedSubtitles()
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    await adapter.copySourceSubtitles()
    expect(writeText).not.toHaveBeenCalled()
    await adapter.copySourceSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:03,000 --> 00:00:05,000\nNext track.")
  })

  it("preserves prepared source text when translated preparation uses the unchanged track", async () => {
    const { adapter, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copySourceSubtitles()
    await adapter.copyTranslatedSubtitles()
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Ready)
    const copied = adapter.copySourceSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:00,000 --> 00:00:02,000\nFirst track.")
    await copied
  })

  it("does not publish an old pending source load after translated preparation selects a new track", async () => {
    const { adapter, first, selectNextTrack, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    first.cues = []
    const oldSource = adapter.copySourceSubtitles()
    await vi.advanceTimersByTimeAsync(0)
    selectNextTrack()
    await adapter.copyTranslatedSubtitles()
    expect(subtitlesStore.get(translatedSubtitlesCopyStatusAtom).phase).toBe(
      SubtitleCopyPhase.Ready,
    )
    first.cues = [{ text: "First track.", startTime: 0, endTime: 2 }]
    await vi.advanceTimersByTimeAsync(100)
    await oldSource
    expect(subtitlesStore.get(sourceSubtitlesCopyStatusAtom).phase).toBe(SubtitleCopyPhase.Idle)
    expect(writeText).not.toHaveBeenCalled()
    await adapter.copySourceSubtitles()
    await adapter.copySourceSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:03,000 --> 00:00:05,000\nNext track.")
  })

  it("prepares the new target language instead of copying an export prepared for the old target", async () => {
    const { adapter, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copyTranslatedSubtitles()
    fixture.targetCode = "jpn"
    subtitlesStore.set(configAtom, {
      ...subtitlesStore.get(configAtom),
      language: { ...subtitlesStore.get(configAtom).language, targetCode: "jpn" },
    })
    await adapter.copyTranslatedSubtitles()
    expect(writeText).not.toHaveBeenCalled()
    await adapter.copyTranslatedSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:00,000 --> 00:00:02,000\njpn:First track.")
  })

  it("preserves source readiness and immediate clipboard invocation when only the target language changes", async () => {
    const { adapter, fetcher, writeText } = setup()
    await vi.advanceTimersByTimeAsync(0)
    await adapter.copySourceSubtitles()
    fixture.targetCode = "jpn"
    subtitlesStore.set(configAtom, {
      ...subtitlesStore.get(configAtom),
      language: { ...subtitlesStore.get(configAtom).language, targetCode: "jpn" },
    })
    const fetch = vi.spyOn(fetcher, "fetch")
    const copied = adapter.copySourceSubtitles()
    expect(writeText).toHaveBeenCalledWith("1\n00:00:00,000 --> 00:00:02,000\nFirst track.")
    expect(fetch).not.toHaveBeenCalled()
    await copied
  })

  it("keeps native captions hidden when x.com polls while the initial enabled fetch is unfinished", async () => {
    const { adapter, fetcher, first, video, emitTrackChange } = setup()
    await vi.advanceTimersByTimeAsync(0)
    fixture.targetCode = "eng"
    first.cues = []
    let visible = false
    Object.assign(adapter, {
      subtitlesScheduler: {
        start: () => {},
        show: () => {
          visible = true
        },
        hide: () => {
          visible = false
        },
        isActive: () => visible,
        reset: () => {},
        setState: () => {},
        getVideoElement: () => video,
        supplementSubtitles: () => {},
      },
    })
    const cleanup = vi.spyOn(fetcher, "cleanup")
    adapter.toggleSubtitlesManually(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(first.mode).toBe("hidden")
    await vi.advanceTimersByTimeAsync(XCOM_STATUS_POLL_INTERVAL_MS)
    expect(first.mode).toBe("hidden")
    expect(cleanup).not.toHaveBeenCalled()
    first.cues = [{ text: "First track.", startTime: 0, endTime: 2 }]
    await vi.advanceTimersByTimeAsync(100)
    expect(subtitlesStore.get(sourceTrackAtom)).toEqual([
      { text: "First track.", start: 0, end: 2000 },
    ])
    // A real identity change after loading still refreshes the active session,
    // and cleanup must reattach native-caption hiding for the replacement.
    first.label = "Fixture replacement"
    await adapter.handleSourceTrackChanged()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(first.mode).toBe("hidden")
    first.mode = "showing"
    emitTrackChange()
    expect(first.mode).toBe("hidden")
    adapter.toggleSubtitlesManually(false)
    expect(first.mode).toBe("showing")
  })
})
