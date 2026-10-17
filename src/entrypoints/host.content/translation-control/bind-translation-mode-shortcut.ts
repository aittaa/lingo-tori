import type { Hotkey } from "@tanstack/hotkeys"
import type { TranslationMode } from "@/types/config/translate"
import { HotkeyManager } from "@tanstack/hotkeys"
import { toastManager } from "@/components/ui/base-ui/toast"
import { getLocalConfig, setLocalConfig } from "@/utils/config/storage"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { getTranslationOnlyBlockedReason } from "@/utils/providers/translation-only-gate"
import { isShortcutEmpty, isValidShortcut } from "@/utils/shortcut"

const NEXT_MODE: Record<TranslationMode, TranslationMode> = {
  bilingual: "translationOnly",
  translationOnly: "bilingual",
}

export async function bindTranslationModeShortcutKey() {
  const config = await getLocalConfig()
  if (!config || isShortcutEmpty(config.pageTranslation.modeShortcut)) {
    return () => {}
  }

  const shortcut = config.pageTranslation.modeShortcut
  if (!isValidShortcut(shortcut)) {
    return () => {}
  }

  const registration = HotkeyManager.getInstance().register(
    shortcut as Hotkey,
    async () => {
      const currentConfig = await getLocalConfig()
      if (!currentConfig) return

      const currentMode = currentConfig.pageTranslation.mode
      const nextMode = NEXT_MODE[currentMode]

      // Entering translationOnly is blocked while the page-translate provider
      // has no markup support (translation-only-gate.ts) — keep the mode and
      // surface the reason instead.
      const blockedReason =
        nextMode === "translationOnly" ? getTranslationOnlyBlockedReason(currentConfig) : null
      if (blockedReason !== null) {
        toastManager.add({ type: "info", title: blockedReason })
        return
      }

      try {
        await setLocalConfig({
          ...currentConfig,
          pageTranslation: {
            ...currentConfig.pageTranslation,
            mode: nextMode,
          },
        })
      } catch (error) {
        // The change was refused or could not be stored (for example the saved settings cannot be
        // read). Say so on the page instead of letting the key press do nothing, and do not throw
        // out of the page's key handler.
        logger.error("Could not change the translation mode", error)
        toastManager.add({
          type: "error",
          title: error instanceof Error ? error.message : "Could not change the translation mode",
        })
        return
      }

      const modeName = i18n.t(`options.translation.preference.translationMode.mode.${nextMode}`)
      toastManager.add({
        type: "info",
        title: i18n.t("options.translation.preference.translationMode.switched", [modeName]),
      })
    },
    {
      ignoreInputs: true,
      preventDefault: true,
      stopPropagation: true,
    },
  )

  return () => {
    registration.unregister()
  }
}
