import type { Config } from "@/types/config/config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import { i18n } from "@/utils/i18n"
import {
  initializeContextMenu,
  MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX,
  MENU_ID_SELECTION_TRANSLATE,
  MENU_ID_TRANSLATE,
  registerContextMenuListeners,
} from "../context-menu"

// vi.mock factories run during the static imports above, before this module's
// own top-level code, so the mocks they return must be hoisted with them.
const { sendMessageMock, ensureInitializedConfigMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn<(...args: any[]) => any>(),
  ensureInitializedConfigMock: vi.fn<(...args: any[]) => any>(),
}))
const storageGetItemMock = vi.fn<(...args: any[]) => any>()
const menuUpdateMock = vi.fn<(...args: any[]) => any>()
const onActivatedListenerMock = vi.fn<(...args: any[]) => any>()
const onUpdatedListenerMock = vi.fn<(...args: any[]) => any>()
const onStorageChangedListenerMock = vi.fn<(...args: any[]) => any>()
const tabsQueryMock = vi.fn<(...args: any[]) => any>()
const storageSetItemMock = vi.fn<(...args: any[]) => any>()
const contextMenuClickListeners: Array<(info: any, tab?: any) => Promise<void> | void> = []

vi.mock("@/utils/message", () => ({
  sendMessage: sendMessageMock,
}))

vi.mock("../config", () => ({
  ensureInitializedConfig: ensureInitializedConfigMock,
}))

function createConfig(enabled: boolean): Config {
  return {
    contextMenu: {
      enabled,
    },
    selectionToolbar: {
      builtInActions: {
        dictionary: {
          enabled: false,
          providerId: "read-frog-free-ai",
        },
        sentenceAnalysis: {
          enabled: false,
          providerId: "read-frog-free-ai",
        },
      },
      customActions: [],
    },
  } as unknown as Config
}

describe("background context menu", () => {
  beforeEach(() => {
    contextMenuClickListeners.length = 0
    vi.clearAllMocks()
    // The real sendMessage always returns a promise (an answer, or a rejection when the
    // tab has no receiver).
    sendMessageMock.mockResolvedValue(undefined)

    browser.contextMenus.create = vi.fn<(...args: any[]) => any>()
    browser.contextMenus.removeAll = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
    browser.contextMenus.update = menuUpdateMock
    menuUpdateMock.mockResolvedValue(undefined)
    browser.contextMenus.onClicked.addListener = vi.fn<(...args: any[]) => any>((listener) => {
      contextMenuClickListeners.push(listener as (info: any, tab?: any) => Promise<void> | void)
    })

    browser.tabs.query = tabsQueryMock
    tabsQueryMock.mockResolvedValue([{ id: 1 }])
    browser.tabs.onActivated.addListener = onActivatedListenerMock
    browser.tabs.onUpdated.addListener = onUpdatedListenerMock
    browser.storage.session.onChanged.addListener = onStorageChangedListenerMock

    storage.watch = vi.fn<(...args: any[]) => any>()
    storage.getItem = storageGetItemMock
    storageGetItemMock.mockResolvedValue({ enabled: true })
    storage.setItem = storageSetItemMock
    storageSetItemMock.mockResolvedValue(undefined)

    i18n.t = vi.fn<(...args: any[]) => any>(
      (key: string) =>
        ({
          "contextMenu.translate": "Translate",
          "contextMenu.translateSelection": 'Translate "%s"',
          "contextMenu.readAloudSelection": 'Read aloud "%s"',
          "contextMenu.showOriginal": "Show Original",
          "options.selectionToolbar.customActions.templates.dictionary.name": "Dictionary",
          "options.selectionToolbar.customActions.templates.sentenceAnalysis.name":
            "Sentence Analysis",
        })[key] ?? key,
    ) as typeof i18n.t
  })

  it("creates page and selection menu items when the context menu is enabled", async () => {
    ensureInitializedConfigMock.mockResolvedValue(createConfig(true))

    await initializeContextMenu()

    expect(browser.contextMenus.removeAll).toHaveBeenCalledOnce()
    expect(browser.contextMenus.create).toHaveBeenNthCalledWith(1, {
      id: MENU_ID_TRANSLATE,
      title: "Translate",
      contexts: ["page"],
    })
    expect(browser.contextMenus.create).toHaveBeenNthCalledWith(2, {
      id: MENU_ID_SELECTION_TRANSLATE,
      title: 'Translate "%s"',
      contexts: ["selection"],
    })
    expect(browser.contextMenus.create).toHaveBeenCalledTimes(2)
    expect(browser.contextMenus.update).toHaveBeenCalledWith(MENU_ID_TRANSLATE, {
      title: "Show Original",
    })
  })

  it("creates custom action items inline for enabled custom actions", async () => {
    const config = createConfig(true)
    config.selectionToolbar.customActions = [
      { id: "dictionary", name: "Dictionary", enabled: true },
      { id: "disabled", name: "Disabled", enabled: false },
      { id: "rewrite", name: "Rewrite", enabled: true },
    ] as Config["selectionToolbar"]["customActions"]
    ensureInitializedConfigMock.mockResolvedValue(config)

    await initializeContextMenu()

    expect(browser.contextMenus.create).toHaveBeenNthCalledWith(3, {
      id: `${MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX}dictionary`,
      title: "Dictionary",
      contexts: ["selection"],
    })
    expect(browser.contextMenus.create).toHaveBeenNthCalledWith(4, {
      id: `${MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX}rewrite`,
      title: "Rewrite",
      contexts: ["selection"],
    })
  })

  it("creates the built-in Dictionary item when it is enabled", async () => {
    const config = createConfig(true)
    config.selectionToolbar.builtInActions.dictionary.enabled = true
    ensureInitializedConfigMock.mockResolvedValue(config)

    await initializeContextMenu()

    expect(browser.contextMenus.create).toHaveBeenNthCalledWith(3, {
      id: `${MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX}default-dictionary`,
      title: "Dictionary",
      contexts: ["selection"],
    })
  })

  it("creates the built-in Sentence Analysis item after the Dictionary's", async () => {
    const config = createConfig(true)
    config.selectionToolbar.builtInActions.dictionary.enabled = true
    config.selectionToolbar.builtInActions.sentenceAnalysis.enabled = true
    ensureInitializedConfigMock.mockResolvedValue(config)

    await initializeContextMenu()

    expect(browser.contextMenus.create).toHaveBeenNthCalledWith(4, {
      id: `${MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX}default-sentence-analysis`,
      title: "Sentence Analysis",
      contexts: ["selection"],
    })
  })

  it("removes menu items without recreating them when the context menu is disabled", async () => {
    ensureInitializedConfigMock.mockResolvedValue(createConfig(false))

    await initializeContextMenu()

    expect(browser.contextMenus.removeAll).toHaveBeenCalledOnce()
    expect(browser.contextMenus.create).not.toHaveBeenCalled()
    expect(browser.contextMenus.update).not.toHaveBeenCalled()
  })

  describe("translate menu title after a click", () => {
    async function clickTranslateMenu(stored: { enabled: boolean }) {
      ensureInitializedConfigMock.mockResolvedValue(createConfig(true))
      storageGetItemMock.mockResolvedValue(stored)
      // The tab clicked in is the one in front, as it is when a user opens the menu.
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      registerContextMenuListeners()
      const clickHandler = contextMenuClickListeners[0]
      if (!clickHandler) {
        throw new Error("Context menu click listener was not registered")
      }
      await clickHandler(
        { menuItemId: MENU_ID_TRANSLATE },
        { id: 5, url: "https://example.com/articles/1" },
      )
    }

    it("switches to Show Original once a page manager acknowledged the start", async () => {
      await clickTranslateMenu({ enabled: false })

      expect(sendMessageMock).toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        5,
      )
      expect(browser.contextMenus.update).toHaveBeenCalledWith(MENU_ID_TRANSLATE, {
        title: "Show Original",
      })
    })

    it("switches to Show Original when the manager's answer says it accepted the start", async () => {
      sendMessageMock.mockResolvedValue({ start: "accepted" })

      await clickTranslateMenu({ enabled: false })

      expect(browser.contextMenus.update).toHaveBeenCalledWith(MENU_ID_TRANSLATE, {
        title: "Show Original",
      })
    })

    it("keeps the title when the manager received the start but refused it (it has told the user why)", async () => {
      sendMessageMock.mockResolvedValue({ start: "rejected" })

      await clickTranslateMenu({ enabled: false })

      expect(browser.contextMenus.update).not.toHaveBeenCalled()
    })

    it.each([
      "Could not establish connection. Receiving end does not exist.",
      "Extension context invalidated.",
    ])("keeps the title when no page manager heard the request (%s)", async (message) => {
      sendMessageMock.mockRejectedValue(new Error(message))

      await clickTranslateMenu({ enabled: false })

      expect(browser.contextMenus.update).not.toHaveBeenCalled()
    })
  })

  describe("translate menu title when the acknowledgement is late", () => {
    const TAB_PAGE = "https://example.com/articles/1"

    function createDeferred() {
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
      })
      return { promise, resolve, reject }
    }

    async function flush() {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    const stateKey = (tabId: number) => getTranslationStateKey(tabId)
    const storageEventKey = (tabId: number) => stateKey(tabId).replace("session:", "")
    const titles = () => menuUpdateMock.mock.calls.map(([, props]) => props.title)

    /** Every ask to a tab's manager waits for the next deferred, in order. */
    function holdAcknowledgements() {
      const held: Array<ReturnType<typeof createDeferred>> = []
      sendMessageMock.mockImplementation((name: string) => {
        if (name !== "askManagerToTogglePageTranslation") return Promise.resolve(undefined)
        const next = createDeferred()
        held.push(next)
        return next.promise
      })
      return held
    }

    function setup(states: Record<string, unknown>) {
      ensureInitializedConfigMock.mockResolvedValue(createConfig(true))
      storageGetItemMock.mockImplementation(async (key: string) => states[key])
      registerContextMenuListeners()
      const click = contextMenuClickListeners[0]!
      const activated = onActivatedListenerMock.mock.calls[0]![0] as (info: any) => Promise<void>
      const storageChanged = onStorageChangedListenerMock.mock.calls[0]![0] as (
        changes: any,
      ) => Promise<void>
      return {
        clickIn: (tabId: number) =>
          click({ menuItemId: MENU_ID_TRANSLATE }, { id: tabId, url: TAB_PAGE }) as Promise<void>,
        activated,
        storageChanged,
      }
    }

    it("a tab switch while the acknowledgement is pending: the late acknowledgement leaves the new tab's title alone", async () => {
      const held = holdAcknowledgements()
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      const { clickIn, activated } = setup({ [stateKey(5)]: { enabled: false } })

      const clicking = clickIn(5)
      await flush()
      expect(held).toHaveLength(1)
      // The user moves to a tab that was never translated; the activation listener sets its title.
      tabsQueryMock.mockResolvedValue([{ id: 6 }])
      await activated({ tabId: 6 })
      expect(titles()).toEqual(["Translate"])

      held[0]!.resolve()
      await clicking
      await flush()

      expect(titles()).toEqual(["Translate"])
    })

    it("leaving the tab and coming back while the acknowledgement is pending: the activation already set its title, so the late acknowledgement does not", async () => {
      const held = holdAcknowledgements()
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      const { clickIn, activated } = setup({ [stateKey(5)]: { enabled: false } })

      const clicking = clickIn(5)
      await flush()
      tabsQueryMock.mockResolvedValue([{ id: 6 }])
      await activated({ tabId: 6 })
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      await activated({ tabId: 5 })
      // Both activations titled the item from the stored state, which has no translation yet.
      expect(titles()).toEqual(["Translate", "Translate"])

      held[0]!.resolve()
      await clicking
      await flush()

      expect(titles()).toEqual(["Translate", "Translate"])
    })

    it("a newer off state for the tab while the acknowledgement is pending: the late acknowledgement does not bring Show Original back", async () => {
      const held = holdAcknowledgements()
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      const states: Record<string, unknown> = { [stateKey(5)]: { enabled: false } }
      const { clickIn, storageChanged } = setup(states)

      const clicking = clickIn(5)
      await flush()
      // A newer state for this very tab arrives (the listener titles it from the new value).
      states[stateKey(5)] = { enabled: false, userDisabled: true }
      await storageChanged({
        [storageEventKey(5)]: { newValue: { enabled: false, userDisabled: true } },
      })
      expect(titles()).toEqual(["Translate"])

      held[0]!.resolve()
      await clicking
      await flush()

      expect(titles()).toEqual(["Translate"])
    })

    it("a newer click on the same tab supersedes the older one: only the newer acknowledgement sets the title", async () => {
      const held = holdAcknowledgements()
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      const { clickIn } = setup({ [stateKey(5)]: { enabled: false } })

      const first = clickIn(5)
      await flush()
      const second = clickIn(5)
      await flush()
      expect(held).toHaveLength(2)

      held[0]!.resolve()
      await first
      await flush()
      expect(titles()).toEqual([])

      held[1]!.resolve()
      await second
      await flush()
      expect(titles()).toEqual(["Show Original"])
    })

    it("a state event for another tab does not supersede it", async () => {
      const held = holdAcknowledgements()
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      const { clickIn, storageChanged } = setup({ [stateKey(5)]: { enabled: false } })

      const clicking = clickIn(5)
      await flush()
      await storageChanged({ [storageEventKey(6)]: { newValue: { enabled: true } } })
      held[0]!.resolve()
      await clicking
      await flush()

      expect(titles()).toEqual(["Show Original"])
    })

    it("after an off that could not be delivered, the title follows the persisted state, not the failed delivery", async () => {
      const held = holdAcknowledgements()
      tabsQueryMock.mockResolvedValue([{ id: 5 }])
      const { clickIn, storageChanged } = setup({ [stateKey(5)]: { enabled: true } })

      const clicking = clickIn(5)
      await flush()
      // The refusal was written before the ask, which fires the storage listener.
      await storageChanged({
        [storageEventKey(5)]: { newValue: { enabled: false, userDisabled: true } },
      })
      held[0]!.reject(new Error("Could not establish connection. Receiving end does not exist."))
      await clicking
      await flush()

      expect(titles()).toEqual(["Translate"])
    })
  })

  it("records a scoped user refusal when the translate menu disables translation", async () => {
    registerContextMenuListeners()

    const clickHandler = contextMenuClickListeners[0]
    if (!clickHandler) {
      throw new Error("Context menu click listener was not registered")
    }

    // storage.getItem defaults to { enabled: true }, so this click toggles off.
    await clickHandler(
      { menuItemId: MENU_ID_TRANSLATE },
      { id: 5, url: "https://example.com/articles/1" },
    )

    expect(storageSetItemMock).toHaveBeenCalledWith("session:translationState.5", {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    })
  })

  it("routes selection menu clicks to the matching tab and frame", async () => {
    registerContextMenuListeners()

    const clickHandler = contextMenuClickListeners[0]
    if (!clickHandler) {
      throw new Error("Context menu click listener was not registered")
    }

    await clickHandler(
      {
        menuItemId: MENU_ID_SELECTION_TRANSLATE,
        selectionText: "Selected text",
        frameId: 7,
      },
      {
        id: 5,
      },
    )

    expect(sendMessageMock).toHaveBeenCalledWith(
      "openSelectionTranslationFromContextMenu",
      { selectionText: "Selected text" },
      { tabId: 5, frameId: 7 },
    )
  })

  it("routes custom action menu clicks to the matching tab and frame", async () => {
    registerContextMenuListeners()

    const clickHandler = contextMenuClickListeners[0]
    if (!clickHandler) {
      throw new Error("Context menu click listener was not registered")
    }

    await clickHandler(
      {
        menuItemId: `${MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX}dictionary`,
        selectionText: "Selected text",
        frameId: 7,
      },
      {
        id: 5,
      },
    )

    expect(sendMessageMock).toHaveBeenCalledWith(
      "openSelectionCustomActionFromContextMenu",
      { actionId: "dictionary", selectionText: "Selected text" },
      { tabId: 5, frameId: 7 },
    )
  })
})
