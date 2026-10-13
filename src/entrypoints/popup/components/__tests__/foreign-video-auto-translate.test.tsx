// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { PreferenceSection } from "@/entrypoints/options/pages/video-subtitles/preference"
import { storageAdapter } from "@/utils/atoms/storage-adapter"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { ForeignVideoAutoTranslate } from "../foreign-video-auto-translate"

const TITLE = "options.videoSubtitles.preference.autoStart.title"

// What a change in another context delivers to every context watching the config key. The
// notification only says "reread"; the value comes from storage.
const watchers = new Set<(newValue: never) => void>()
const notifyWatchers = () => watchers.forEach((notify) => notify(undefined as never))

// What the extension keeps in storage, as every context reads it.
async function seedStorage(edit?: (config: Config) => void) {
  const config = structuredClone(DEFAULT_CONFIG)
  edit?.(config)
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  return config
}

async function storedConfig() {
  return (await getLocalConfig())!
}

// Each store is one extension context with its own config atom: the popup, or an options tab.
function mountPopup() {
  const { container } = render(
    <Provider store={createStore()}>
      <TooltipProvider>
        <ForeignVideoAutoTranslate />
      </TooltipProvider>
    </Provider>,
  )
  return within(container).getByRole("switch", { name: TITLE })
}

function mountSettings() {
  const { container } = render(
    <Provider store={createStore()}>
      <MemoryRouter>
        <PreferenceSection />
      </MemoryRouter>
    </Provider>,
  )
  // The page's switches, in order: enable, auto-translate, AI segmentation.
  return within(container).getAllByRole("switch")[1]!
}

describe("popup auto-translate switch for foreign videos", () => {
  beforeEach(() => {
    watchers.clear()
    vi.spyOn(storageAdapter, "watch").mockImplementation((_key, callback) => {
      watchers.add(callback)
      return () => {
        watchers.delete(callback)
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    fakeBrowser.reset()
  })

  it("is a named switch, off until the setting is turned on", async () => {
    await seedStorage()

    const popup = mountPopup()

    expect(popup).toHaveAccessibleName(TITLE)
    expect(popup).not.toBeChecked()
  })

  it("shows what the settings page already stored", async () => {
    await seedStorage((config) => {
      config.videoSubtitles.autoStart = true
    })

    const popup = mountPopup()

    await waitFor(() => expect(popup).toBeChecked())
  })

  it("stores the one videoSubtitles.autoStart flag, where the content script reads it, and nothing else", async () => {
    const before = await seedStorage()
    const popup = mountPopup()

    fireEvent.click(popup)

    await waitFor(async () => expect((await storedConfig()).videoSubtitles.autoStart).toBe(true))
    expect(await storedConfig()).toEqual({
      ...before,
      videoSubtitles: { ...before.videoSubtitles, autoStart: true },
    })

    fireEvent.click(popup)

    await waitFor(async () => expect((await storedConfig()).videoSubtitles.autoStart).toBe(false))
    expect(await storedConfig()).toEqual(before)
  })

  it("moves the settings page's switch, and is moved by it", async () => {
    await seedStorage()
    const popup = mountPopup()
    const settings = mountSettings()
    expect(settings).not.toBeChecked()

    fireEvent.click(popup)
    await waitFor(() => expect(settings).toBeChecked())
    expect(popup).toBeChecked()

    fireEvent.click(settings)
    await waitFor(() => expect(popup).not.toBeChecked())
    expect(settings).not.toBeChecked()
    expect((await storedConfig()).videoSubtitles.autoStart).toBe(false)
  })

  it("follows a change made in another context once the storage watch says to reread", async () => {
    const before = await seedStorage()
    const popup = mountPopup()
    const settings = mountSettings()
    // Both views watch the config key; without that there would be nothing to wait for below.
    await waitFor(() => expect(watchers.size).toBe(2))

    // Not through either view: a write from a third context, as a second popup or tab would make.
    await fakeBrowser.storage.local.set({
      [CONFIG_STORAGE_KEY]: {
        ...before,
        videoSubtitles: { ...before.videoSubtitles, autoStart: true },
      },
    })
    notifyWatchers()

    await waitFor(() => expect(popup).toBeChecked())
    await waitFor(() => expect(settings).toBeChecked())
  })

  it("keeps a sibling setting that another context changed before the switch was flipped", async () => {
    const before = await seedStorage()
    const popup = mountPopup()
    await fakeBrowser.storage.local.set({
      [CONFIG_STORAGE_KEY]: {
        ...before,
        videoSubtitles: { ...before.videoSubtitles, aiSegmentation: true },
      },
    })

    fireEvent.click(popup)

    await waitFor(async () => expect((await storedConfig()).videoSubtitles.autoStart).toBe(true))
    expect((await storedConfig()).videoSubtitles.aiSegmentation).toBe(true)
  })
})
