import "@/utils/zod-config"
import type { UiLanguage } from "@/types/config/config"
import { browser, defineBackground } from "#imports"
import { selectFreshTranslateProviders } from "@/utils/config/default-translate-provider"
import { watchConfigStatus } from "@/utils/config/status"
import { initI18n, setUiLanguage } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { openOptionsPage } from "@/utils/navigation"
import { ONBOARDING_ROUTE } from "@/utils/onboarding/lifecycle"
import { setupAiSegmentationHandlers } from "./ai-segmentation"
import { setupApiUsage } from "./api-usage"
import { dispatchBackgroundStreamPort } from "./background-stream"
import { initializeActionIcons, registerActionIconListeners } from "./browser-action-icon"
import { setupByos } from "./byos"
import {
  ensureInitializedConfig,
  getInitializeConfigResult,
  isFreshInstalledConfig,
} from "./config"
import { setUpConfigBackup } from "./config-backup"
import { initializeContextMenu, registerContextMenuListeners } from "./context-menu"
import {
  cleanupAllAiSegmentationCache,
  cleanupAllSummaryCache,
  cleanupAllTranslationCache,
  setUpDatabaseCleanup,
} from "./db-cleanup"
import { setupGlossaryMessageHandlers } from "./glossary"
import { setupIframeInjection } from "./iframe-injection"
import { setupLLMGenerateTextMessageHandlers } from "./llm-generate-text"
import { initMockData } from "./mock-data"
import { handleInstallOnboarding, setupOnboardingMessageHandlers } from "./onboarding"
import { setupPageTranslationHandlers } from "./page-translation"
import { proxyFetch } from "./proxy-fetch"
import { setupSidePanelMessageHandler } from "./side-panel"
import { setupSubtitlesTranslationHandlers } from "./subtitles-translation"
import { translationMessage } from "./translation-signal"
import { setupVideoSummaryHandlers } from "./video-summary"

export default defineBackground({
  type: "module",
  main: () => {
    logger.info("Hello background!", { id: browser.runtime.id })

    browser.runtime.onInstalled.addListener(async (details) => {
      await ensureInitializedConfig()
      if (await isFreshInstalledConfig()) await selectFreshTranslateProviders()
      if (details.reason === "install") {
        // Enrols a first install that found no config; every other install opens settings as before.
        const onboardingStarted = await handleInstallOnboarding({
          reason: details.reason,
          initResult: await getInitializeConfigResult(),
        })
        if (onboardingStarted) await openOptionsPage({ route: ONBOARDING_ROUTE })
        else await openOptionsPage()
      }
    })

    onMessage("openPage", async (message) => {
      const { url, active } = message.data
      logger.info("openPage", { url, active })
      await browser.tabs.create({ url, active: active ?? true })
    })

    onMessage("openOptionsPage", async (message) => {
      logger.info("openOptionsPage", message.data)
      await openOptionsPage(message.data)
    })

    setupSidePanelMessageHandler({
      extensionBrowser: browser,
      logger,
      registerMessageHandler: onMessage,
    })

    setupAiSegmentationHandlers()

    browser.runtime.onConnect.addListener((port) => {
      dispatchBackgroundStreamPort(port)
    })

    onMessage("clearAllTranslationRelatedCache", async () => {
      await cleanupAllTranslationCache()
      await cleanupAllSummaryCache()
    })

    onMessage("clearAiSegmentationCache", async () => {
      await cleanupAllAiSegmentationCache()
    })

    setupOnboardingMessageHandlers()

    translationMessage()
    registerActionIconListeners()

    // Register context menu listeners synchronously
    // This ensures listeners are registered before Chrome completes initialization
    registerContextMenuListeners()

    // Initialize action icons asynchronously
    void initializeActionIcons()

    // Synchronous: all translation and summary handlers register in the first turn of
    // the SW so wake-triggering messages are never dropped during init.
    setupApiUsage()
    setupPageTranslationHandlers()
    setupSubtitlesTranslationHandlers()
    setupVideoSummaryHandlers()
    void setUpDatabaseCleanup()
    setUpConfigBackup()

    // Start config and i18n initialization without delaying synchronous listener
    // registration. Consumers that materialize localized config-derived data await
    // this shared barrier before reading it.
    let currentUiLanguage: UiLanguage | undefined
    const backgroundReady = (async () => {
      const config = await ensureInitializedConfig()
      currentUiLanguage = config?.uiLanguage ?? "auto"
      await initI18n(currentUiLanguage)
    })()

    proxyFetch()

    setupGlossaryMessageHandlers()
    setupByos()

    setupLLMGenerateTextMessageHandlers()

    void initMockData()

    // Setup on-demand iframe injection after page translation is enabled.
    setupIframeInjection()

    // i18n bootstrap for the non-React background context. Runs after the synchronous
    // listener registration above (MV3 requires listeners before the first await). The
    // context menu and the uninstall-survey URL both resolve i18n.t at registration time,
    // so they must be created AFTER initI18n or they freeze in the wrong language.
    void (async () => {
      await backgroundReady
      void initializeContextMenu()
    })()

    // Keep background-resolved strings in the selected language when it changes.
    // The context menu re-creates itself via its own config watcher
    // (registerContextMenuListeners), so here we only drive the i18next singleton and
    // re-set the frozen (localized) uninstall-survey URL.
    watchConfigStatus(({ config: newConfig }) => {
      if (!newConfig) return
      void (async () => {
        await backgroundReady
        if (newConfig.uiLanguage === currentUiLanguage) return
        currentUiLanguage = newConfig.uiLanguage
        await setUiLanguage(newConfig.uiLanguage)
      })()
    })
  },
})
