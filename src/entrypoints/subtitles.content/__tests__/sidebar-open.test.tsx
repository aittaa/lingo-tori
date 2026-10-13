// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { queryClient } from "@/utils/tanstack-query"
import {
  currentVideoIdAtom,
  nativeSubtitleTranslationBlockedAtom,
  sourceTrackAtom,
  subtitlesSidebarOpenAtom,
  subtitlesStore,
  subtitlesVisibleAtom,
  translatedTrackAtom,
} from "../atoms"
import { TranslationCoordinator } from "../translation-coordinator"
import { SubtitlesSidebarItem } from "../ui/subtitles-settings-panel/components/subtitles-sidebar-item"
import { SubtitlesSidebar } from "../ui/subtitles-sidebar"
import { TranscriptSection } from "../ui/subtitles-sidebar/sections/transcript"
import { SubtitlesProviders } from "../ui/subtitles-ui-context"
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
// Anything a translation start would ask of a provider goes through here.
vi.mock("@/utils/subtitles/processor/translator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/subtitles/processor/translator")>()),
  resolveSubtitlesProviderRef: mocks.resolveSubtitlesProviderRef,
  fetchSubtitlesSummary: mocks.fetchSubtitlesSummary,
  translateSubtitles: mocks.translateSubtitles,
}))
vi.mock("@/utils/subtitles/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/subtitles/toast")>()),
  showAnchoredSubtitlesToast: vi.fn<(...args: any[]) => any>(),
  showSubtitlesErrorToast: vi.fn<(...args: any[]) => any>(),
}))
// The real panel, open gating and transcript, without the tab bar's layout.
vi.mock("../ui/subtitles-sidebar/sidebar-shell", () => ({
  SidebarShell: () => (
    <div data-slot="scroll-area">
      <div data-slot="scroll-area-viewport" tabIndex={0}>
        <TranscriptSection />
      </div>
      <div data-slot="scroll-area-scrollbar" />
    </div>
  ),
}))

const PROVIDER_ID = "panel-provider"
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// A provider is chosen and the video is in another language: the case a start would translate.
function configFor(autoStart: boolean) {
  return {
    language: { targetCode: "kor" },
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

const spies: Array<{ mockRestore: () => void }> = []
const track = <T extends { mockRestore: () => void }>(spy: T) => {
  spies.push(spy)
  return spy
}

let adapter: UniversalVideoAdapter
let fetcher: {
  fetch: ReturnType<typeof vi.fn<(...args: any[]) => any>>
}
let scheduler: Record<string, ReturnType<typeof vi.fn<(...args: any[]) => any>>>
let switchSpy: { mock: { calls: unknown[][] } }
let coordinatorStart: { mock: { calls: unknown[][] } }
let hideNative: { mock: { calls: unknown[][] } }

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn<() => void>()
  window.matchMedia = vi.fn<() => MediaQueryList>().mockReturnValue({
    matches: false,
  } as MediaQueryList)
})

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  mocks.resolveSubtitlesProviderRef.mockReset()
  mocks.fetchSubtitlesSummary.mockResolvedValue(undefined)
  mocks.getLocalConfig.mockResolvedValue(configFor(false))
  subtitlesStore.set(subtitlesSidebarOpenAtom, false)
  subtitlesStore.set(subtitlesVisibleAtom, false)
  subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
  subtitlesStore.set(sourceTrackAtom, [])
  subtitlesStore.set(translatedTrackAtom, [])

  const subtitlesFetcher = {
    fetch: vi
      .fn<(...args: any[]) => any>()
      .mockResolvedValue([{ text: "hello", start: 0, end: 1000 }]),
    cleanup: vi.fn<(...args: any[]) => any>(),
    shouldUseSameTrack: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
    getSourceLanguage: () => "en",
    hasAvailableSubtitles: vi.fn<(...args: any[]) => any>().mockResolvedValue(true),
  }
  fetcher = subtitlesFetcher
  adapter = new UniversalVideoAdapter({
    config: {
      selectors: { video: "video", playerContainer: ".player", nativeSubtitles: ".captions" },
      events: {},
      supportsSidebar: true,
      getVideoId: () => "A",
    },
    fetchers: { native: () => subtitlesFetcher },
  })
  scheduler = {
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
  ;(adapter as any).subtitlesScheduler = scheduler
  ;(adapter as any).publishVideoId()
  switchSpy = track(vi.spyOn(adapter as any, "switchSubtitlesFetcher"))
  coordinatorStart = track(
    vi.spyOn(TranslationCoordinator.prototype, "start").mockImplementation(() => undefined),
  )
  hideNative = track(vi.spyOn(adapter as any, "hideNativeSubtitles").mockImplementation(() => {}))
  track(vi.spyOn(adapter as any, "showNativeSubtitles").mockImplementation(() => {}))
})

afterEach(() => {
  cleanup()
  for (const spy of spies.splice(0)) spy.mockRestore()
  queryClient.clear()
  subtitlesStore.set(subtitlesSidebarOpenAtom, false)
  subtitlesStore.set(sourceTrackAtom, [])
  subtitlesStore.set(currentVideoIdAtom, null)
})

function renderPanel() {
  return render(
    <SubtitlesProviders adapter={adapter}>
      <SubtitlesSidebarItem />
      <SubtitlesSidebar />
    </SubtitlesProviders>,
  )
}

const menuEntry = () => screen.getByRole("button", { name: "subtitles.sidebar.menu.label" })

// Subtitles are exactly as they were: not shown, not translated, no native captions hidden, and
// nothing asked of a provider.
function expectSubtitlesUntouched() {
  expect(subtitlesStore.get(subtitlesVisibleAtom)).toBe(false)
  expect(switchSpy.mock.calls).toHaveLength(0)
  expect(coordinatorStart.mock.calls).toHaveLength(0)
  expect(hideNative.mock.calls).toHaveLength(0)
  for (const method of ["start", "show", "hide", "setState", "supplementSubtitles"]) {
    expect(scheduler[method]).not.toHaveBeenCalled()
  }
  expect(mocks.resolveSubtitlesProviderRef).not.toHaveBeenCalled()
  expect(mocks.fetchSubtitlesSummary).not.toHaveBeenCalled()
  expect(mocks.translateSubtitles).not.toHaveBeenCalled()
  expect(subtitlesStore.get(nativeSubtitleTranslationBlockedAtom)).toBe(false)
}

// Clicks the panel's menu entry on the video as set up; resolves with the first transcript line,
// which comes from the captions the panel loads for itself.
function openPanel({ autoStart, switchedOff }: { autoStart: boolean; switchedOff: boolean }) {
  mocks.getLocalConfig.mockResolvedValue(configFor(autoStart))
  if (switchedOff) {
    adapter.toggleSubtitlesManually(false)
    scheduler.hide!.mockClear()
  }
  renderPanel()
  fireEvent.click(menuEntry())
  return screen.findByText("hello")
}

describe("opening the learning panel", () => {
  it.each([
    ["autoStart is off", { autoStart: false, switchedOff: false }],
    [
      "autoStart is on and the video is in another language",
      { autoStart: true, switchedOff: false },
    ],
    [
      "the viewer switched this video off with autoStart on",
      { autoStart: true, switchedOff: true },
    ],
  ])("shows the transcript and leaves the subtitles alone when %s", async (_case, setup) => {
    expect(await openPanel(setup)).toBeInTheDocument()

    expect(subtitlesStore.get(subtitlesSidebarOpenAtom)).toBe(true)
    expect(fetcher.fetch).toHaveBeenCalledOnce()
    expectSubtitlesUntouched()
  })

  it("does not undo the viewer's switch-off, so a remount of the same video still holds", async () => {
    expect(await openPanel({ autoStart: true, switchedOff: true })).toBeInTheDocument()

    await (adapter as any).tryAutoStartSubtitles()
    await settle()

    expect(fetcher.fetch).toHaveBeenCalledOnce()
    expectSubtitlesUntouched()
  })
})
