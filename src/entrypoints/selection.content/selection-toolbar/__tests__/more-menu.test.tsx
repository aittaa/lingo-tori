// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configAtom, configFieldsAtomMap } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { i18n } from "@/utils/i18n"
import { DropEvent } from "../close-button"
import { SelectionToolbarMoreMenu } from "../more-menu"

const PROVIDER_ID = "test-provider"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
  openToolbarTranslation: vi.fn<(anchor: HTMLElement | null) => void>(),
  openToolbarCustomAction: vi.fn<(actionId: string, anchor: HTMLElement | null) => void>(),
  toggleSpeech: vi.fn<() => boolean>(() => true),
}))

// The settings atom reads the session view of the stored config. A test can have the next read
// answer with a view of its own (see the stale assignment below); every other read is the real one.
const nextView = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock("@/utils/config/status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/config/status")>()
  return {
    ...actual,
    getConfigView: async () => {
      const view = nextView.value
      nextView.value = undefined
      return view ?? actual.getConfigView()
    },
  }
})

vi.mock("@/utils/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/message")>()),
  sendMessage: mocks.sendMessage,
}))

vi.mock("../translate-button/provider", () => ({
  useSelectionTranslationPopover: () => ({ openToolbarTranslation: mocks.openToolbarTranslation }),
}))

vi.mock("../custom-action-button/provider", () => ({
  useSelectionCustomActionPopover: () => ({
    openToolbarCustomAction: mocks.openToolbarCustomAction,
  }),
}))

vi.mock("../speak-button", () => ({
  useSelectionSpeech: () => ({
    isFetching: false,
    isPlaying: false,
    label: "Speak",
    toggle: mocks.toggleSpeech,
  }),
}))

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  fakeBrowser.reset()
})

// The stored config too: the config atom reloads it once mounted.
async function renderMenu(edit?: (config: Config) => void) {
  const store = createStore()
  const config = structuredClone(DEFAULT_CONFIG)
  // Every feature the menu can run gets a provider; a test then takes one away.
  config.providersConfig = [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true },
  ]
  config.selectionToolbar.features.translate.providerId = PROVIDER_ID
  config.selectionToolbar.builtInActions.dictionary.providerId = PROVIDER_ID
  config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = PROVIDER_ID
  edit?.(config)
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <TooltipProvider>
        <SelectionToolbarMoreMenu />
      </TooltipProvider>
    </Provider>,
  )
  return store
}

const trigger = () => screen.getByRole("button", { name: i18n.t("action.moreActions") })

async function openMenu() {
  fireEvent.click(trigger())
  await waitFor(() => expect(document.querySelector("[data-item-id]")).not.toBeNull())
}

const itemIds = () =>
  [...document.querySelectorAll<HTMLElement>("[data-item-id]")].map((row) => row.dataset.itemId)

const row = (id: string) => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!

const pinButton = (id: string) =>
  within(row(id)).getByRole("button", {
    name: new RegExp(`${i18n.t("action.pinToToolbar")}|${i18n.t("action.unpinFromToolbar")}`),
  })

describe("SelectionToolbarMoreMenu", () => {
  it("lists every enabled item in the toolbar's order, pinned or not", async () => {
    await renderMenu((config) => {
      const dictionary = getBuiltInDictionaryAction(config.selectionToolbar)
      config.selectionToolbar.customActions = [
        { ...dictionary, id: "mine", name: "Mine" },
        { ...dictionary, id: "off", name: "Off", enabled: false },
      ]
      config.selectionToolbar.order = ["mine", "speak", "off", "translate"]
      config.selectionToolbar.unpinned = ["mine", "off"]
    })
    await openMenu()

    // A disabled item is nowhere, pinned or not.
    expect(itemIds()).toEqual([
      "mine",
      "translate",
      "default-dictionary",
      "default-sentence-analysis",
    ])
    expect(within(row("mine")).getByText("Mine")).toBeInTheDocument()
    expect(within(row("translate")).getByText(i18n.t("action.translation"))).toBeInTheDocument()
    expect(pinButton("mine")).toHaveAccessibleName(i18n.t("action.pinToToolbar"))
    expect(pinButton("translate")).toHaveAccessibleName(i18n.t("action.unpinFromToolbar"))
  })

  it("pins and unpins an item without touching its enabled switch", async () => {
    const store = await renderMenu((config) => {
      config.selectionToolbar.unpinned = ["default-sentence-analysis"]
    })
    await openMenu()

    fireEvent.click(pinButton("translate"))
    fireEvent.click(pinButton("default-sentence-analysis"))

    await waitFor(() => {
      expect(store.get(configFieldsAtomMap.selectionToolbar).unpinned).toEqual(["translate"])
    })
    const selectionToolbar = store.get(configFieldsAtomMap.selectionToolbar)
    expect(selectionToolbar.features.translate.enabled).toBe(true)
    expect(selectionToolbar.builtInActions.sentenceAnalysis.enabled).toBe(true)
    expect(pinButton("translate")).toHaveAccessibleName(i18n.t("action.pinToToolbar"))
    expect(pinButton("default-sentence-analysis")).toHaveAccessibleName(
      i18n.t("action.unpinFromToolbar"),
    )
  })

  it("runs an item from its row, anchored at the menu's button, and closes", async () => {
    const dropdownStates: boolean[] = []
    const onDropdown = (event: Event) =>
      dropdownStates.push(Boolean((event as CustomEvent).detail?.open))
    window.addEventListener(DropEvent, onDropdown)
    await renderMenu()

    await openMenu()
    const dictionary = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)
    fireEvent.click(within(row("default-dictionary")).getByText(dictionary.name))
    expect(mocks.openToolbarCustomAction).toHaveBeenCalledWith("default-dictionary", trigger())

    await openMenu()
    fireEvent.click(within(row("translate")).getByText(i18n.t("action.translation")))
    expect(mocks.openToolbarTranslation).toHaveBeenCalledWith(trigger())

    // Open and closed each time, so the toolbar stays up only while it is open.
    expect(dropdownStates).toEqual([true, false, true, false])
    window.removeEventListener(DropEvent, onDropdown)
  })

  // The run button is the second one in a row: the drag grip comes first.
  const runButton = (id: string) => within(row(id)).getAllByRole("button")[1]!

  it("holds back only the row whose own feature has no provider, and leaves pinning alone", async () => {
    const store = await renderMenu((config) => {
      config.selectionToolbar.builtInActions.dictionary.providerId = "unconfigured"
    })
    await openMenu()
    const dictionary = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)

    const held = within(row("default-dictionary")).getByRole("button", { name: dictionary.name })
    expect(held).toBeDisabled()
    expect(held).toHaveAccessibleDescription("providerRequired.message")
    fireEvent.click(held)
    expect(mocks.openToolbarCustomAction).not.toHaveBeenCalled()

    // Translation and sentence analysis run on providers of their own.
    expect(runButton("translate")).toBeEnabled()
    expect(runButton("default-sentence-analysis")).toBeEnabled()

    fireEvent.click(pinButton("default-dictionary"))
    await waitFor(() => {
      expect(store.get(configFieldsAtomMap.selectionToolbar).unpinned).toContain(
        "default-dictionary",
      )
    })
  })

  it("holds back the translate row on its own feature, without a provider", async () => {
    await renderMenu((config) => {
      config.selectionToolbar.features.translate.providerId = "unconfigured"
    })
    await openMenu()

    expect(runButton("translate")).toBeDisabled()
    expect(runButton("default-dictionary")).toBeEnabled()
    expect(runButton("default-sentence-analysis")).toBeEnabled()
    fireEvent.click(runButton("translate"))
    expect(mocks.openToolbarTranslation).not.toHaveBeenCalled()
  })

  it("links a held-back row to its own provider setting and closes the menu", async () => {
    await renderMenu((config) => {
      config.selectionToolbar.builtInActions.dictionary.providerId = "unconfigured"
      config.selectionToolbar.features.translate.providerId = "unconfigured"
    })
    await openMenu()
    const dictionary = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)

    const dictionarySettings = within(row("default-dictionary")).getByRole("button", {
      name: `${dictionary.name}: providerRequired.openSettings`,
    })
    expect(dictionarySettings).toHaveAccessibleDescription("providerRequired.message")
    dictionarySettings.focus()
    expect(dictionarySettings).toHaveFocus()
    runButton("default-dictionary").focus()
    expect(dictionarySettings).toHaveFocus()
    fireEvent.click(dictionarySettings)
    expect(mocks.sendMessage).toHaveBeenLastCalledWith("openOptionsPage", {
      route: "/api-providers?section=feature-provider-action-default-dictionary",
    })

    // The menu closed on that click, so it opens again from its button.
    await openMenu()
    fireEvent.click(
      within(row("translate")).getByRole("button", {
        name: `${i18n.t("action.translation")}: providerRequired.openSettings`,
      }),
    )
    expect(mocks.sendMessage).toHaveBeenLastCalledWith("openOptionsPage", {
      route: "/api-providers?section=feature-provider-selectionTranslation",
    })
  })

  it.each([
    [
      "deleted",
      (config: Config) => {
        config.providersConfig = []
      },
    ],
    [
      "disabled",
      (config: Config) => {
        config.providersConfig[0]!.enabled = false
      },
    ],
  ])("holds back every row when the one provider is %s", async (_case, edit) => {
    await renderMenu(edit)
    await openMenu()

    expect(runButton("translate")).toBeDisabled()
    expect(runButton("default-dictionary")).toBeDisabled()
    expect(runButton("default-sentence-analysis")).toBeDisabled()
  })

  it("opens the provider hint on a disabled row's hover wrapper", async () => {
    await renderMenu((config) => {
      config.selectionToolbar.features.translate.providerId = "unconfigured"
    })
    await openMenu()
    const wrapper = runButton("translate").closest("[data-slot=tooltip-trigger]")!
    fireEvent.mouseEnter(wrapper)
    fireEvent.mouseMove(wrapper, { clientX: 1, clientY: 1 })

    await waitFor(() => {
      expect(document.querySelector("[data-slot=tooltip-content][data-open]")).toHaveTextContent(
        "providerRequired.message",
      )
    })
    expect(mocks.openToolbarTranslation).not.toHaveBeenCalled()
  })

  it("holds back an AI action assigned to a translation-only provider", async () => {
    await renderMenu((config) => {
      config.providersConfig = [
        ...config.providersConfig,
        { ...structuredClone(DEFAULT_PROVIDER_CONFIG.deepl), enabled: true },
      ]
      config.selectionToolbar.builtInActions.dictionary.providerId =
        DEFAULT_PROVIDER_CONFIG.deepl.id
      // Simulate the UI's stale assignment directly. The storage schema rejects this
      // snapshot and otherwise replaces every feature with defaults on mount.
      nextView.value = { config, status: { kind: "usable" } }
    })
    await openMenu()

    expect(runButton("default-dictionary")).toBeDisabled()
    expect(runButton("translate")).toBeEnabled()
  })
})
