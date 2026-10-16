import type { ContentScriptContext } from "#imports"
import type { LangCodeISO6393 } from "@/lib/languages"
import type { Config } from "@/types/config/config"
import type { PageTranslationStartOutcome } from "@/utils/message"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { detectPageLanguageLightweight } from "@/utils/content/page-language"
import { ensurePresetStyles } from "@/utils/host/translate/ui/style-injector"
import { logger } from "@/utils/logger"
import { onMessage, sendMessage } from "@/utils/message"
import { clearEffectiveSiteControlUrl } from "@/utils/site-control"
import { areSamePageTranslationOrigin } from "@/utils/url"
import { setupUrlChangeListener } from "./listen"
import { mountHostToast } from "./mount-host-toast"
import { bindTranslationModeShortcutKey } from "./translation-control/bind-translation-mode-shortcut"
import { bindTranslationShortcutKey } from "./translation-control/bind-translation-shortcut"
import { registerNodeTranslationTriggers } from "./translation-control/node-translation"
import { PageTranslationManager } from "./translation-control/page-translation"

export async function bootstrapHostContent(
  ctx: ContentScriptContext,
  initialConfig: Config | null,
) {
  ensurePresetStyles(document)

  const cleanupUrlListener = setupUrlChangeListener()

  const removeHostToast = window === window.top ? mountHostToast() : () => {}

  const teardownNodeTranslation = registerNodeTranslationTriggers()

  const preloadConfig =
    initialConfig?.pageTranslation.page.preload ?? DEFAULT_CONFIG.pageTranslation.page.preload
  let detectedPageLanguage: { url: string; code: LangCodeISO6393 | "und" } | undefined
  let detectionGeneration = 0
  const manager = new PageTranslationManager(
    {
      root: null,
      rootMargin: `${preloadConfig.margin}px`,
      threshold: preloadConfig.threshold,
    },
    (url) => (detectedPageLanguage?.url === url ? detectedPageLanguage.code : undefined),
  )

  const cleanupPageTranslationTriggers = manager.registerPageTranslationTriggers()

  // The tab-title switch applies to an already-translated page at once. Only
  // the top frame owns the title, so iframes skip parsing every config write.
  const cleanupTitleTranslationWatch =
    window === window.top
      ? storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (config) => {
          const parsedConfig = configSchema.safeParse(config)
          if (parsedConfig.success) {
            manager.setTitleTranslationEnabled(
              parsedConfig.data.pageTranslation.page.translateTitle,
            )
          }
        })
      : () => {}

  const cleanupTranslationShortcut = await bindTranslationShortcutKey(manager)

  const cleanupTranslationModeShortcut = await bindTranslationModeShortcutKey()

  const detectAndReportPageLanguage = async (url: string) => {
    const generation = ++detectionGeneration
    detectedPageLanguage = undefined
    const { detectedCodeOrUnd } = await detectPageLanguageLightweight()
    if (generation === detectionGeneration && url === window.location.href) {
      detectedPageLanguage = { url, code: detectedCodeOrUnd }
    }
    void sendMessage("reportDetectedPageLanguage", { url, detectedCodeOrUnd })
  }

  // For late-loading iframes: check if translation is already enabled for this tab
  let translationEnabled = false
  try {
    translationEnabled = await sendMessage("getEnablePageTranslationFromContentScript", undefined)
  } catch (error) {
    // Extension context may be invalidated during update, proceed without auto-start
    logger.error("Failed to check translation state:", error)
  }
  if (translationEnabled) {
    void manager.start()
  }

  const handleUrlChange = async (from: string, to: string) => {
    if (from !== to) {
      detectionGeneration += 1
      detectedPageLanguage = undefined
      logger.info("URL changed from", from, "to", to)
      if (manager.isActive) {
        if (areSamePageTranslationOrigin(from, to)) {
          // Same-document route change: keep the session and wrappers
          // mounted — the MutationObserver walks the new route's DOM as the
          // router inserts it. Site CSS is swapped for the new path;
          // persistent DOM keeps its old walk decisions (accepted tradeoff,
          // see refreshSiteRuleCSS).
          await manager.refreshSiteRuleCSS()
        } else {
          manager.stop()
        }
      }
      // Only the top frame should detect and set language to avoid race conditions from iframes
      if (window === window.top) {
        await detectAndReportPageLanguage(to)
      }
    }
  }

  const handleExtensionUrlChange = (e: any) => {
    const { from, to } = e.detail
    void handleUrlChange(from, to)
  }
  window.addEventListener("extension:URLChange", handleExtensionUrlChange)

  // Listen for translation state changes from background
  const cleanupTranslationStateListener = onMessage("askManagerToTogglePageTranslation", (msg) => {
    const { enabled, analyticsContext } = msg.data
    // Only a redundant ON is skipped. `isActive` stays false for the whole span
    // of a start still awaiting its gates (config read, provider availability),
    // so comparing an OFF against it would drop the OFF and let that start
    // switch translation on after the user turned it off — and its ON notice
    // would overwrite the background's manual-off record. An OFF always goes to
    // stop(), which cancels a pending start as well as a live session.
    // A start is answered once the manager has decided it (its precheck passed or refused it), not
    // when the page has been walked: whoever asked can then tell a start that was accepted from one
    // that was only received. A redundant ON is accepted: the page is translating.
    if (enabled && manager.isActive) return { start: "accepted" as const }
    if (enabled) {
      return new Promise<{ start: PageTranslationStartOutcome }>((resolve) => {
        void manager.start(window === window.top ? analyticsContext : undefined, (start) =>
          resolve({ start }),
        )
      })
    }
    // Invariant: every sender of askManagerToTogglePageTranslation with
    // enabled=false is a user surface (popup button, floating button,
    // context menu) — the auto-translation path only ever sends
    // enabled=true — so a disable here is always user-initiated.
    manager.stop({ userInitiated: true })
    return undefined
  })

  const cleanupFrameTranslationStateListener =
    window === window.top
      ? () => {}
      : onMessage("notifyTranslationStateChanged", (msg) => {
          const { enabled } = msg.data
          // Same rule as the toggle request above: never drop an OFF.
          if (enabled && manager.isActive) return
          if (enabled) {
            void manager.start()
          } else {
            manager.stop()
          }
        })

  const cleanupDetectedLanguageRefreshListener =
    window === window.top
      ? onMessage("refreshDetectedPageLanguage", () => {
          void detectAndReportPageLanguage(window.location.href)
        })
      : () => {}

  ctx.onInvalidated(() => {
    removeHostToast()
    cleanupUrlListener()
    teardownNodeTranslation()
    cleanupPageTranslationTriggers()
    cleanupTitleTranslationWatch()
    cleanupTranslationShortcut()
    cleanupTranslationModeShortcut()
    cleanupTranslationStateListener()
    cleanupFrameTranslationStateListener()
    cleanupDetectedLanguageRefreshListener()
    window.removeEventListener("extension:URLChange", handleExtensionUrlChange)
    window.__READ_FROG_HOST_INJECTED__ = false
    clearEffectiveSiteControlUrl()
  })

  // Only the top frame should detect and set language to avoid race conditions from iframes
  if (window === window.top) {
    await detectAndReportPageLanguage(window.location.href)
  }
}
