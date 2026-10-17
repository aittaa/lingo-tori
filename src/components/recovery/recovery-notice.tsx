import type { KeptCopySummary } from "@/utils/config/recovery-export"
import type { SuspectReason } from "@/utils/config/status"
import { useMutation } from "@tanstack/react-query"
import { saveAs } from "file-saver"
import { useEffect, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/base-ui/alert-dialog"
import { Button } from "@/components/ui/base-ui/button"
import { toastManager } from "@/components/ui/base-ui/toast"
import {
  buildKeptCopyExport,
  buildStoredAsFoundExport,
  listKeptCopies,
} from "@/utils/config/recovery-export"
import { getConfigStatus } from "@/utils/config/status"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"

type Target = { kind: "kept"; key: string } | { kind: "stored" }

interface RecoveryExportState {
  copies: KeptCopySummary[]
  /** The stored config cannot be used (or has not been upgraded), so an export "as found" is offered. */
  storedUnusable: boolean
}

const REASON_KEYS = {
  "invalid-schema": "recoveryExport.reason.invalid-schema",
  "migration-failed": "recoveryExport.reason.migration-failed",
  "newer-version": "recoveryExport.reason.newer-version",
  incoherent: "recoveryExport.reason.incoherent",
} as const satisfies Record<SuspectReason, string>

async function loadState(): Promise<RecoveryExportState> {
  const [copies, status] = await Promise.all([listKeptCopies(), getConfigStatus()])
  return { copies, storedUnusable: status.kind === "suspect" || status.kind === "upgrading" }
}

/**
 * The narrow recovery export: when this version cannot use the stored settings, they can still be
 * saved to a file exactly as they are. Shown on the settings page and on the error screen. It
 * renders nothing when there is nothing to export. It never shows a stored value; each download is
 * preceded by a warning that the file holds credentials in plain text.
 */
export function RecoveryExport() {
  const [state, setState] = useState<RecoveryExportState>()
  const [target, setTarget] = useState<Target>()

  useEffect(() => {
    let active = true
    loadState().then(
      (loaded) => {
        if (active) setState(loaded)
      },
      (error: unknown) => logger.error("Could not look for kept copies of the settings", error),
    )
    return () => {
      active = false
    }
  }, [])

  const { mutate: download, isPending } = useMutation({
    meta: { errorDescription: i18n.t("recoveryExport.failed") },
    mutationFn: async (chosen: Target) => {
      const file =
        chosen.kind === "kept"
          ? await buildKeptCopyExport(chosen.key)
          : await buildStoredAsFoundExport()
      saveAs(new Blob([file.json], { type: "application/json" }), file.fileName)
    },
    onSuccess: () => {
      toastManager.add({ type: "success", title: i18n.t("recoveryExport.saved") })
    },
  })

  if (!state || (state.copies.length === 0 && !state.storedUnusable)) return null

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      data-testid="recovery-export"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{i18n.t("recoveryExport.title")}</h3>
        <p className="text-sm text-muted-foreground">{i18n.t("recoveryExport.description")}</p>
      </div>

      {state.copies.map((copy) => (
        <div key={copy.key} className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {i18n.t("recoveryExport.keptCopy", [new Date(copy.capturedAt).toLocaleString()])}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(REASON_KEYS[copy.reason])}{" "}
              {i18n.t("recoveryExport.keptBy", [copy.extensionVersion])}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => setTarget({ kind: "kept", key: copy.key })}
          >
            {i18n.t("recoveryExport.exportCopy")}
          </Button>
        </div>
      ))}

      {state.storedUnusable && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{i18n.t("recoveryExport.storedTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {i18n.t("recoveryExport.storedDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => setTarget({ kind: "stored" })}
          >
            {i18n.t("recoveryExport.exportStored")}
          </Button>
        </div>
      )}

      <AlertDialog
        open={target !== undefined}
        onOpenChange={(open) => !open && setTarget(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{i18n.t("recoveryExport.warning.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {i18n.t("recoveryExport.warning.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{i18n.t("recoveryExport.warning.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (target) download(target)
                setTarget(undefined)
              }}
            >
              {i18n.t("recoveryExport.warning.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
