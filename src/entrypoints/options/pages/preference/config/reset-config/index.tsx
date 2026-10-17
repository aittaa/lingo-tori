import { IconRefresh } from "@tabler/icons-react"
import { useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/base-ui/alert-dialog"
import { Button } from "@/components/ui/base-ui/button"
import { toastManager } from "@/components/ui/base-ui/toast"
import { replaceStoredConfig } from "@/utils/backup/current-config"
import { EXTENSION_VERSION } from "@/utils/constants/app"
import { buildFreshDefaultConfig } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"
import { ConfigItem } from "../../../../components/config-item"

export function ResetConfigItem() {
  const [open, setOpen] = useState(false)
  async function resetToDefaultConfig() {
    try {
      await replaceStoredConfig(buildFreshDefaultConfig(), {
        backupCurrent: false,
        extensionVersion: EXTENSION_VERSION,
      })
    } catch (error) {
      // Refused (for example the saved settings cannot be read) or not stored: say so, since the
      // dialog is about to close and the click would otherwise look like it did nothing.
      toastManager.add({
        type: "error",
        title: i18n.t("errorRecovery.resetFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
    }
    setOpen(false)
  }

  return (
    <ConfigItem
      id="reset-config"
      title={i18n.t("options.preference.config.reset.title")}
      description={i18n.t("options.preference.config.reset.description")}
    >
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
          <IconRefresh />
          {i18n.t("options.preference.config.reset.dialog.trigger")}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {i18n.t("options.preference.config.reset.dialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {i18n.t("options.preference.config.reset.dialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {i18n.t("options.preference.config.reset.dialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={resetToDefaultConfig}>
              {i18n.t("options.preference.config.reset.dialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfigItem>
  )
}
