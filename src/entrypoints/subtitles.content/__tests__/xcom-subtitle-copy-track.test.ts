// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://x.com/fixture/status/1234567890"}
import type { ContentScriptContext } from "#imports"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    language: { ...DEFAULT_CONFIG.language, sourceCode: "eng", targetCode: "kor" },
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
  translateSubtitles: async (fragments: Array<{ text: string; start: number; end: number }>) =>
    fragments.map((fragment) => ({ ...fragment, translation: `ko:${fragment.text}` })),
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
  Object.defineProperty(video, "textTracks", { value: [first, second] })
  fixture.video = video
  fixture.container = document.createElement("div")
  fixture.videoId = "1234567890"
  const adapter = new UniversalVideoAdapter({
    config: {
      selectors: { video: "video", playerContainer: ".fixture-player" },
      events: {},
      getVideoId: () => fixture.videoId,
    },
    fetchers: {
      native: () =>
        new TextTrackFetcher({ resolveVideo: () => video, getVideoId: () => fixture.videoId }),
    },
  })
  // Only renderer/scheduler setup is skipped. Track selection, fetching, copying and
  // initializer polling below run through their actual production implementations.
  vi.spyOn(adapter, "initialize").mockResolvedValue(undefined)
  fixture.adapter = adapter
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  initXcomSubtitles({
    onInvalidated: (cleanup: () => void) => fixture.cleanup.push(cleanup),
  } as ContentScriptContext)
  return {
    adapter,
    writeText,
    selectNextTrack: () => {
      first.mode = "disabled"
      second.mode = "showing"
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  subtitlesStore.set(sourceTrackAtom, [])
  for (const atom of [sourceSubtitlesCopyStatusAtom, translatedSubtitlesCopyStatusAtom]) {
    subtitlesStore.set(atom, { phase: SubtitleCopyPhase.Idle, progress: null })
  }
})
afterEach(() => {
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
})
