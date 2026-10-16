import type { Browser } from "#imports"
import type { Config } from "@/types/config/config"
import { browser, storage } from "#imports"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import {
  getTranslationStateKey,
  parseTabIdFromStorageKey,
  TRANSLATION_STATE_KEY_PREFIX,
} from "@/utils/constants/storage-keys"
import { getSelectionToolbarActions } from "@/utils/custom-actions"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import { ensureInitializedConfig } from "./config"
import { getPageTranslationEnabled, setPageTranslationEnabled } from "./page-translation-state"

export const MENU_ID_TRANSLATE = "read-frog-translate"
export const MENU_ID_SELECTION_TRANSLATE = "read-frog-selection-translate"
export const MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX = "read-frog-selection-custom-action:"

function getSelectionCustomActionMenuId(actionId: string) {
  return `${MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX}${actionId}`
}

/**
 * Per tab, a count of the things that set the translate item's title for it: a click, the tab
 * becoming (or ceasing to be) the active one, its page finishing loading, a change of its stored
 * state, a rebuild of the menu. The item is one global object, so a click that waits for its
 * acknowledgement may only write its title if none of these happened to its tab meanwhile;
 * otherwise whichever listener ran has already set the right one.
 */
const titleGenerations = new Map<number, number>()

function bumpTitleGeneration(tabId: number): number {
  const next = (titleGenerations.get(tabId) ?? 0) + 1
  titleGenerations.set(tabId, next)
  return next
}

function getTitleGeneration(tabId: number): number {
  return titleGenerations.get(tabId) ?? 0
}

/** Whether the tab is the active one of the window the user last focused. */
async function isFrontTab(tabId: number): Promise<boolean> {
  const [frontTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
  return frontTab?.id === tabId
}

/**
 * Register all context menu event listeners synchronously
 * This must be called during main() execution to ensure listeners are registered
 * before Chrome completes initialization
 */
export function registerContextMenuListeners() {
  // Listen for config changes to update context menu
  storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, async (newConfig) => {
    if (newConfig) {
      await updateContextMenuItems(newConfig)
    }
  })

  // Listen for tab activation to update menu title
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    bumpTitleGeneration(activeInfo.tabId)
    await updateTranslateMenuTitle(activeInfo.tabId)
  })

  // Listen for tab updates (e.g., navigation)
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      bumpTitleGeneration(tabId)
      await updateTranslateMenuTitle(tabId)
    }
  })

  // Listen for translation state changes in storage
  // This ensures menu updates when translation is toggled from any UI
  // (floating button, auto-translate, etc.) without interfering with
  // the translation logic in translation-signal.ts
  browser.storage.session.onChanged.addListener(async (changes) => {
    for (const [key, change] of Object.entries(changes)) {
      // Check if this is a translation state change
      if (key.startsWith(TRANSLATION_STATE_KEY_PREFIX.replace("session:", ""))) {
        const tabId = parseTabIdFromStorageKey(key)

        if (!Number.isNaN(tabId)) {
          // Counted when it arrives, before any await, so an older click knows it was overtaken.
          bumpTitleGeneration(tabId)
          // Only update menu if this is the active tab
          const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
          if (activeTab?.id === tabId) {
            const newValue = change.newValue as { enabled: boolean } | undefined
            await updateTranslateMenuTitle(tabId, newValue?.enabled)
          }
        }
      }
    }
  })

  // Handle menu item clicks
  browser.contextMenus.onClicked.addListener(handleContextMenuClick)
}

/**
 * Initialize context menu items based on config
 * This can be called asynchronously after listeners are registered
 */
export async function initializeContextMenu() {
  // Ensure config is initialized before setting up context menu
  const config = await ensureInitializedConfig()
  if (!config) {
    return
  }

  await updateContextMenuItems(config)
}

/**
 * Update context menu items based on config
 */
async function updateContextMenuItems(config: Config) {
  // Remove all existing menu items first
  await browser.contextMenus.removeAll()

  const { enabled: translateEnabled } = config.contextMenu
  const enabledCustomActions = getSelectionToolbarActions(config.selectionToolbar).filter(
    (action) => action.enabled !== false,
  )

  if (translateEnabled) {
    browser.contextMenus.create({
      id: MENU_ID_TRANSLATE,
      title: i18n.t("contextMenu.translate"),
      contexts: ["page"],
    })

    browser.contextMenus.create({
      id: MENU_ID_SELECTION_TRANSLATE,
      title: i18n.t("contextMenu.translateSelection"),
      contexts: ["selection"],
    })

    if (enabledCustomActions.length > 0) {
      enabledCustomActions.forEach((action) => {
        browser.contextMenus.create({
          id: getSelectionCustomActionMenuId(action.id),
          title: action.name,
          contexts: ["selection"],
        })
      })
    }
  }

  // Update translate menu title for current tab
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (activeTab?.id) {
    bumpTitleGeneration(activeTab.id)
    await updateTranslateMenuTitle(activeTab.id)
  }
}

/**
 * Update translate menu title based on current translation state
 * @param tabId - The tab ID to check translation state for
 * @param enabled - Optional: if provided, use this value instead of reading from storage
 * @param isStillCurrent - Optional: asked just before the write; the write is dropped if it says no
 */
async function updateTranslateMenuTitle(
  tabId: number,
  enabled?: boolean,
  isStillCurrent?: () => boolean | Promise<boolean>,
) {
  const config = await ensureInitializedConfig()
  if (!config?.contextMenu.enabled) {
    return
  }

  try {
    let isTranslated: boolean
    if (enabled !== undefined) {
      isTranslated = enabled
    } else {
      const state = await storage.getItem<{ enabled: boolean }>(getTranslationStateKey(tabId))
      isTranslated = state?.enabled ?? false
    }

    // Asked as late as possible: it is the last thing awaited before the write.
    if (isStillCurrent && !(await isStillCurrent())) {
      return
    }

    await browser.contextMenus.update(MENU_ID_TRANSLATE, {
      title: isTranslated ? i18n.t("contextMenu.showOriginal") : i18n.t("contextMenu.translate"),
    })
  } catch {
    // Menu item might not exist if translateEnabled is false
  }
}

/**
 * Handle context menu item click
 */
async function handleContextMenuClick(
  info: Browser.contextMenus.OnClickData,
  tab?: Browser.tabs.Tab,
) {
  if (!tab?.id) {
    return
  }

  if (info.menuItemId === MENU_ID_TRANSLATE) {
    await handleTranslateClick(tab.id, tab.url)
    return
  }

  if (info.menuItemId === MENU_ID_SELECTION_TRANSLATE) {
    await handleSelectionTranslateClick(info, tab.id)
    return
  }

  if (
    typeof info.menuItemId === "string" &&
    info.menuItemId.startsWith(MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX)
  ) {
    const actionId = info.menuItemId.slice(MENU_ID_SELECTION_CUSTOM_ACTION_PREFIX.length)
    if (!actionId) {
      return
    }

    await handleSelectionCustomActionClick(info, tab.id, actionId)
  }
}

/**
 * Handle translate menu click - toggle page translation
 */
async function handleTranslateClick(tabId: number, tabUrl?: string) {
  const generation = bumpTitleGeneration(tabId)
  const isCurrentlyTranslated = await getPageTranslationEnabled(tabId)
  const newState = !isCurrentlyTranslated

  if (!newState) {
    await setPageTranslationEnabled(tabId, false, tabUrl, true)
    void sendMessage("notifyTranslationStateChanged", { enabled: false }, tabId)
  }

  // Notify content script in that specific tab
  const answered = await sendMessage(
    "askManagerToTogglePageTranslation",
    {
      enabled: newState,
      analyticsContext: newState
        ? createFeatureUsageContext(
            ANALYTICS_FEATURE.PAGE_TRANSLATION,
            ANALYTICS_SURFACE.CONTEXT_MENU,
          )
        : undefined,
    },
    tabId,
  ).then(
    (answer) => ({ delivered: true, startRefused: newState && answer?.start === "rejected" }),
    (error) => {
      logger.warn("Failed to ask page translation manager to toggle", error)
      return { delivered: false, startRefused: false }
    },
  )

  // Update the menu title once a manager heard the request, but only if the answer is still
  // about what is on screen: the tab must still be in front, and nothing newer (another click, a
  // tab switch, a stored state change) may have set the title for it while this waited — the
  // listener that ran has already set the right one, and the item is one global object. Both are
  // asked right before the write. With no receiver in the tab the title is left as it is; after
  // an OFF it already follows the stored refusal through the storage listener, delivered or not.
  // A start the manager refused (and told the user about) changed nothing, so the title stays too.
  if (answered.delivered && !answered.startRefused) {
    await updateTranslateMenuTitle(
      tabId,
      newState,
      async () => (await isFrontTab(tabId)) && getTitleGeneration(tabId) === generation,
    )
  }
}

async function handleSelectionTranslateClick(
  info: Browser.contextMenus.OnClickData,
  tabId: number,
) {
  const selectionText = info.selectionText?.trim()
  if (!selectionText) {
    return
  }

  const target = typeof info.frameId === "number" ? { tabId, frameId: info.frameId } : tabId

  void sendMessage(
    "openSelectionTranslationFromContextMenu",
    {
      selectionText,
    },
    target,
  )
}

async function handleSelectionCustomActionClick(
  info: Browser.contextMenus.OnClickData,
  tabId: number,
  actionId: string,
) {
  const selectionText = info.selectionText?.trim()
  if (!selectionText) {
    return
  }

  const target = typeof info.frameId === "number" ? { tabId, frameId: info.frameId } : tabId

  void sendMessage(
    "openSelectionCustomActionFromContextMenu",
    {
      actionId,
      selectionText,
    },
    target,
  )
}
