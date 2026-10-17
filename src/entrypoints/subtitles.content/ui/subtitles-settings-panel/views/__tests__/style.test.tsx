// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { Config } from "@/types/config/config"
import type { SubtitlesSource } from "@/utils/constants/subtitles"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { DEFAULT_DISPLAY_MODE, SUBTITLES_SOURCE } from "@/utils/constants/subtitles"
// The atoms module first: it and the views module import each other, and this is the order the
// extension loads them in.
import {
  nativeSubtitleTranslationBlockedAtom,
  subtitlesSourceAtom,
  subtitlesStore,
  subtitlesVisibleAtom,
} from "../../../../atoms"
import { StyleView } from "../style"

const mocks = vi.hoisted(() => ({
  toggleSubtitles: vi.fn<(enabled: boolean) => void>(),
  logError: vi.fn<(...args: any[]) => any>(),
  // Each <Select>'s change handler, keyed by the value it currently shows.
  changeHandlers: new Map<string, (value: string) => void>(),
}))

vi.mock("../../../subtitles-ui-context", () => ({
  useSubtitlesUI: () => ({ toggleSubtitles: mocks.toggleSubtitles }),
}))

vi.mock("@/utils/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/logger")>()
  return { ...actual, logger: { ...actual.logger, error: mocks.logError } }
})

// The controls this behaviour does not touch are stubs; the <Select>s hand their handlers over.
vi.mock("@/components/ui/base-ui/select", () => {
  const Nothing = () => null
  return {
    Select: ({
      value,
      onValueChange,
    }: {
      value: string
      onValueChange: (value: string) => void
    }) => {
      mocks.changeHandlers.set(value, onValueChange)
      return null
    },
    SelectContent: Nothing,
    SelectGroup: Nothing,
    SelectItem: Nothing,
    SelectTrigger: Nothing,
    SelectValue: Nothing,
  }
})
vi.mock("@/components/debounced-color-picker", () => ({ DebouncedColorPicker: () => null }))
vi.mock("@/components/ui/base-ui/color-picker", () => ({
  ColorPickerPortalContainer: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/ui/base-ui/slider", () => ({ SliderComfortable: () => null }))

const PROVIDER_ID = "style-provider"

type Mode = "bilingual" | "originalOnly" | "translationOnly"

interface RenderOptions {
  mode?: Mode
  providerId?: string
  providerPresent?: boolean
  enabled?: boolean
  blocked?: boolean
  visible?: boolean
  source?: SubtitlesSource
}

const spies: Array<{ mockRestore: () => void }> = []

// The stored config too: the config atom reloads it once mounted.
async function renderStyleView({
  mode = "originalOnly",
  providerId = PROVIDER_ID,
  providerPresent = true,
  enabled = true,
  blocked = true,
  visible = true,
  source = SUBTITLES_SOURCE.NATIVE,
}: RenderOptions = {}) {
  const config: Config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled },
  ].filter(() => providerPresent)
  config.videoSubtitles.providerId = providerId
  config.videoSubtitles.style.displayMode = mode
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  subtitlesStore.set(configAtom, config)
  subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, blocked)
  subtitlesStore.set(subtitlesVisibleAtom, visible)
  subtitlesStore.set(subtitlesSourceAtom, source)
  // Config writes reach storage through the settings service, as one `set` of the config and its
  // meta; the spy sees every `set`, and the tests count the ones that carry the config.
  const setSpy = vi.spyOn(fakeBrowser.storage.local, "set")
  spies.push(setSpy)
  const configWrites = () =>
    setSpy.mock.calls.filter(([items]) => Object.hasOwn(items, CONFIG_STORAGE_KEY)).length
  render(<StyleView />)
  return {
    setSpy,
    // Waits for `writes` config writes to reach storage, then a macrotask for their continuations.
    settled: async (writes = 1) => {
      await waitFor(() => expect(configWrites()).toBe(writes))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
  }
}

const handlerFor = (shownMode: string) => mocks.changeHandlers.get(shownMode)!

async function storedMode() {
  const stored = (await fakeBrowser.storage.local.get(CONFIG_STORAGE_KEY))[
    CONFIG_STORAGE_KEY
  ] as Config
  return stored.videoSubtitles.style.displayMode
}

describe("style view: leaving original-only", () => {
  beforeEach(() => {
    mocks.changeHandlers.clear()
    mocks.logError.mockReset()
    mocks.toggleSubtitles.mockReset()
    // The real start lowers the refusal flag before its first await (see the adapter tests).
    mocks.toggleSubtitles.mockImplementation(() => {
      subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
    })
  })

  afterEach(() => {
    cleanup()
    for (const spy of spies.splice(0)) spy.mockRestore()
    fakeBrowser.reset()
    subtitlesStore.set(configAtom, DEFAULT_CONFIG)
    subtitlesStore.set(nativeSubtitleTranslationBlockedAtom, false)
    subtitlesStore.set(subtitlesVisibleAtom, false)
    subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
  })

  it.each<Mode>(["translationOnly", "bilingual"])(
    "starts again, once the write has landed, when a provider is chosen and the mode becomes %s",
    async (nextMode) => {
      const { settled } = await renderStyleView()

      act(() => {
        handlerFor("originalOnly")(nextMode)
      })
      // The write has not landed yet: nothing is started ahead of it.
      expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
      await settled()

      expect(mocks.toggleSubtitles).toHaveBeenCalledExactlyOnceWith(true)
      expect(subtitlesStore.get(configAtom).videoSubtitles.style.displayMode).toBe(nextMode)
      expect(await storedMode()).toBe(nextMode)
    },
  )

  it("treats the reset button as the same mode change", async () => {
    const { settled } = await renderStyleView()

    // The first reset button belongs to the general settings, which carry the display mode.
    fireEvent.click(screen.getAllByRole("button")[0]!)
    await settled()

    expect(mocks.toggleSubtitles).toHaveBeenCalledExactlyOnceWith(true)
    expect(await storedMode()).toBe(DEFAULT_DISPLAY_MODE)
  })

  it("does not start again when the reset leaves a translated mode", async () => {
    const { settled } = await renderStyleView({ mode: "translationOnly" })

    fireEvent.click(screen.getAllByRole("button")[0]!)
    await settled()

    expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
    expect(await storedMode()).toBe(DEFAULT_DISPLAY_MODE)
  })

  it.each<[string, RenderOptions]>([
    ["no provider is chosen", { providerId: "unconfigured" }],
    ["the provider was deleted", { providerId: "unconfigured", providerPresent: false }],
    [
      "the provider exists but is disabled and unassigned",
      { providerId: "unconfigured", enabled: false },
    ],
    ["subtitles are off", { visible: false }],
    ["the source is AI", { source: SUBTITLES_SOURCE.AI }],
    ["no start was refused or left source-only", { blocked: false }],
  ])("does not start again when %s", async (_case, options) => {
    const { settled } = await renderStyleView(options)

    act(() => {
      handlerFor("originalOnly")("translationOnly")
    })
    await settled()

    expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
    expect(await storedMode()).toBe("translationOnly")
  })

  it("does not start again when the mode being left was not original-only", async () => {
    const { settled } = await renderStyleView({ mode: "bilingual" })

    act(() => {
      handlerFor("bilingual")("translationOnly")
    })
    await settled()

    expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
  })

  it("does not start again for a style change that is not the display mode", async () => {
    const { settled } = await renderStyleView()

    // The second reset button belongs to the main subtitle text style.
    fireEvent.click(screen.getAllByRole("button")[1]!)
    await settled()

    expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
    expect(await storedMode()).toBe("originalOnly")
  })

  it("does not start again when the reader goes back to original-only before the write lands", async () => {
    const { settled } = await renderStyleView()
    const change = handlerFor("originalOnly")

    act(() => {
      change("translationOnly")
      change("originalOnly")
    })
    await settled(2)

    expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
    expect(await storedMode()).toBe("originalOnly")
  })

  it("starts once, not twice, for two writes queued from the same state", async () => {
    const { settled } = await renderStyleView()
    const change = handlerFor("originalOnly")

    act(() => {
      change("translationOnly")
      change("bilingual")
    })
    await settled(2)

    // The first write's start lowers the flag; the second write finds it down.
    expect(mocks.toggleSubtitles).toHaveBeenCalledOnce()
    expect(await storedMode()).toBe("bilingual")
  })

  it("starts nothing, and reports the failure, when the write fails", async () => {
    const { setSpy } = await renderStyleView()
    setSpy.mockRejectedValueOnce(new Error("disk full"))

    act(() => {
      handlerFor("originalOnly")("translationOnly")
    })
    // The settings service reports the failed write too (this test runs both in one process), so
    // what is asserted is that the view's own report is among the logged errors.
    await waitFor(() =>
      expect(mocks.logError).toHaveBeenCalledWith(
        "[subtitles] saving the display mode failed",
        expect.anything(),
      ),
    )

    expect(mocks.toggleSubtitles).not.toHaveBeenCalled()
  })
})
