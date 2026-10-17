import type { Hotkey } from "@tanstack/hotkeys"
import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import { HotkeyManager } from "@tanstack/hotkeys"
import { toastManager } from "@/components/ui/base-ui/toast"
import { getLocalConfig } from "@/utils/config/storage"
import { editConfig } from "@/utils/config/write-guard"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { getTranslationOnlyBlockedReason } from "@/utils/providers/translation-only-gate"
import { isShortcutEmpty, isValidShortcut } from "@/utils/shortcut"

const NEXT_MODE: Record<TranslationMode, TranslationMode> = {
  bilingual: "translationOnly",
  translationOnly: "bilingual",
}

/** The next mode is not allowed for the config the edit was computed from; nothing is stored. */
class TranslationModeBlockedError extends Error {}

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
      // Nothing stored yet: there is no mode to switch.
      if (!(await getLocalConfig())) return

      let committed: Config
      try {
        // The mode is switched by an edit, worked out from the config the settings service
        // compares against and again from the fresh one if the data changed in the meantime, so a
        // setting another context changed since this key press is kept. Entering translationOnly is
        // blocked while the page-translate provider has no markup support (translation-only-gate.ts),
        // and that is checked against the same config.
        committed = await editConfig((currentConfig) => {
          const nextMode = NEXT_MODE[currentConfig.pageTranslation.mode]
          const blockedReason =
            nextMode === "translationOnly" ? getTranslationOnlyBlockedReason(currentConfig) : null
          if (blockedReason !== null) throw new TranslationModeBlockedError(blockedReason)
          return {
            ...currentConfig,
            pageTranslation: { ...currentConfig.pageTranslation, mode: nextMode },
          }
        })
      } catch (error) {
        // Keep the mode and surface the reason.
        if (error instanceof TranslationModeBlockedError) {
          toastManager.add({ type: "info", title: error.message })
          return
        }
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

      const nextMode = committed.pageTranslation.mode
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
