// @vitest-environment jsdom
import { act, render } from "@testing-library/react"
import { Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  adPlayingAtom,
  currentSubtitleAtom,
  currentTimeMsAtom,
  displaySubtitleAtom,
  sourceTrackAtom,
  subtitlesStore,
  translatedTrackAtom,
} from "../atoms"
import { SubtitlesScheduler } from "../subtitles-scheduler"
import { TranslationCoordinator } from "../translation-coordinator"
import { TranslationSubtitle } from "../ui/subtitle-lines"

vi.mock("@/utils/i18n", () => ({
  i18n: {
    t: (key: string) => (key === "subtitles.state.translating" ? "Translating…" : key),
  },
}))

vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  return {
    configFieldsAtomMap: {
      language: atom(DEFAULT_CONFIG.language),
      videoSubtitles: atom(DEFAULT_CONFIG.videoSubtitles),
    },
  }
})

type Cue = { text: string; start: number; end: number; translation?: string }

const CUES: Cue[] = [
  { text: "first", start: 0, end: 1000 },
  { text: "second", start: 1000, end: 2000 },
  { text: "third", start: 2000, end: 3000 },
]
const FIRST_CUE_MS = 500
const FAILED_CUE_MS = 1500

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The real coordinator feeding the real scheduler and atoms, with only the translator stubbed. */
async function setup() {
  const translator = await import("@/utils/subtitles/processor/translator")
  const translate = vi.spyOn(translator, "translateSubtitles")
  const video = {
    currentTime: FIRST_CUE_MS / 1000,
    playbackRate: 1,
    addEventListener: vi.fn<(...args: any[]) => any>(),
    removeEventListener: vi.fn<(...args: any[]) => any>(),
  }
  subtitlesStore.set(sourceTrackAtom, CUES)
  const scheduler = new SubtitlesScheduler({ videoElement: video as unknown as HTMLVideoElement })
  scheduler.start()
  scheduler.show()
  const coordinator = new TranslationCoordinator({
    getFragments: () => CUES,
    getVideoElement: () => video as unknown as HTMLVideoElement,
    getCurrentState: () => scheduler.getState(),
    segmentationPipeline: null,
    onTranslated: (fragments) => scheduler.supplementSubtitles(fragments),
    onStateChange: (state, data) => scheduler.setState(state, data),
  })
  const view = render(
    <Provider store={subtitlesStore}>
      <TranslationSubtitle />
    </Provider>,
  )
  /** Moves playback to a time and lets the player and the component catch up with it. */
  const playAt = async (ms: number) => {
    video.currentTime = ms / 1000
    await act(async () => {
      scheduler.resyncFromVideo()
    })
  }
  return { translate, coordinator, scheduler, view, playAt }
}

/** Translates every cue except the starts named, which the translator leaves without a translation. */
const translateExcept = (failing: number[]) => (batch: Cue[]) =>
  Promise.resolve(
    batch.map((cue) => ({
      ...cue,
      translation: failing.includes(cue.start) ? undefined : `translated ${cue.text}`,
    })),
  ) as any

describe("a partially failed batch as the viewer sees it", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    subtitlesStore.set(sourceTrackAtom, [])
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(currentSubtitleAtom, null)
    subtitlesStore.set(currentTimeMsAtom, 0)
    subtitlesStore.set(adPlayingAtom, false)
  })

  it("shows the translated cues and settles the failed one instead of leaving it translating", async () => {
    const { translate, coordinator, view, playAt } = await setup()
    translate.mockImplementation(translateExcept([1000]))

    coordinator.start()
    await flush()

    await playAt(FIRST_CUE_MS)
    expect(view.container.textContent).toContain("translated first")
    expect(view.container.querySelector("[data-pending='true']")).toBeNull()

    // The cue that failed is settled: nothing is coming for it until the next explicit start,
    // so the component must not show the animated "Translating" label for it.
    await playAt(FAILED_CUE_MS)
    expect(view.container.querySelector("[data-pending='true']")).toBeNull()
    expect(view.container.textContent).not.toContain("Translating")
    // Underneath, the cue on screen is the failed one and carries a settled (empty) translation.
    expect(subtitlesStore.get(displaySubtitleAtom)).toMatchObject({ start: 1000, translation: "" })

    coordinator.stop()
  })

  it("still lets the retry fill the failed cue in, and keeps the one that translated", async () => {
    const { translate, coordinator, view, playAt } = await setup()
    translate.mockImplementation(translateExcept([1000]))
    coordinator.start()
    await flush()

    // What the adapter does when the viewer switches off and on again.
    translate.mockImplementation(translateExcept([]))
    coordinator.stop()
    coordinator.clearFailed()
    coordinator.start()
    await flush()

    expect(translate).toHaveBeenCalledTimes(2)
    expect(translate.mock.calls[1]![0].map((cue: Cue) => cue.start)).toEqual([1000])
    await playAt(FAILED_CUE_MS)
    expect(view.container.textContent).toContain("translated second")
    expect(view.container.querySelector("[data-pending='true']")).toBeNull()
    await playAt(FIRST_CUE_MS)
    expect(view.container.textContent).toContain("translated first")

    coordinator.stop()
  })
})
