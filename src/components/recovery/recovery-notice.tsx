import type { KeptCopySummary } from "@/utils/config/recovery-export"
import type { SuspectReason } from "@/utils/config/status"
import { useMutation } from "@tanstack/react-query"
import { saveAs } from "file-saver"
import { useCallback, useEffect, useState } from "react"
import { browser } from "#imports"
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
import { PRESERVED_ORIGINAL_PREFIX } from "@/utils/config/preservation"
import { restoreFromKeptCopy, startFromDefaults } from "@/utils/config/recovery-actions"
import {
  buildKeptCopyExport,
  buildStoredAsFoundExport,
  listKeptCopies,
} from "@/utils/config/recovery-export"
import { CONFIG_META_STORAGE_KEY, getConfigStatus } from "@/utils/config/status"
import { deletePreservedById } from "@/utils/config/write-guard"
import { EXTENSION_VERSION } from "@/utils/constants/app"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { RECOVERY_NOTICE_SECTION_ID } from "@/utils/navigation"
import { recoveryFailureText } from "./recovery-failure-text"

type Action =
  | { kind: "export-kept"; key: string }
  | { kind: "export-stored" }
  | { kind: "restore"; key: string }
  | { kind: "delete"; key: string }
  | { kind: "defaults" }

interface RecoveryState {
  copies: KeptCopySummary[]
  /** The stored config cannot be used (or has not been upgraded), so it is offered "as found". */
  storedUnusable: boolean
}

const REASON_KEYS = {
  "invalid-schema": "recoveryExport.reason.invalid-schema",
  "migration-failed": "recoveryExport.reason.migration-failed",
  "newer-version": "recoveryExport.reason.newer-version",
  incoherent: "recoveryExport.reason.incoherent",
} as const satisfies Record<SuspectReason, string>

async function loadState(): Promise<RecoveryState> {
  const [copies, status] = await Promise.all([listKeptCopies(), getConfigStatus()])
  return { copies, storedUnusable: status.kind === "suspect" || status.kind === "upgrading" }
}

/** The state of the notice, read again whenever the config, its meta or a kept copy changes. */
function useRecoveryState() {
  const [state, setState] = useState<RecoveryState>()

  const reload = useCallback(() => {
    let current = true
    loadState().then(
      (loaded) => {
        if (current) setState(loaded)
      },
      (error: unknown) => logger.error("Could not look for kept copies of the settings", error),
    )
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    let stop = reload()
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== "local") return
      const relevant = Object.keys(changes).some(
        (key) =>
          key === CONFIG_STORAGE_KEY ||
          key === CONFIG_META_STORAGE_KEY ||
          key.startsWith(PRESERVED_ORIGINAL_PREFIX),
      )
      if (!relevant) return
      stop()
      stop = reload()
    }
    browser.storage.onChanged.addListener(onChanged)
    return () => {
      stop()
      browser.storage.onChanged.removeListener(onChanged)
    }
  }, [reload])

  return state
}

const DIALOGS = {
  "export-kept": "recoveryExport.warning",
  "export-stored": "recoveryExport.warning",
  restore: "recoveryExport.restoreDialog",
  delete: "recoveryExport.deleteDialog",
  defaults: "recoveryExport.defaultsDialog",
} as const

/**
 * The recovery notice: when this version cannot use the stored settings, or copies of settings it
 * could not use are kept, it says so and offers the ways out - save an exact file (after a warning
 * that it holds credentials), try to restore a kept copy, delete one, or start from the defaults.
 * Every replacement goes through the settings service, which keeps an exact, confirmed copy of an
 * unusable config first and writes nothing if that fails. It never shows a stored value, and it
 * renders nothing when there is nothing to say.
 */
export function RecoveryNotice() {
  const state = useRecoveryState()
  const [action, setAction] = useState<Action>()

  const { mutate: run, isPending } = useMutation({
    mutationFn: async (chosen: Action) => {
      switch (chosen.kind) {
        case "export-kept": {
          const file = await buildKeptCopyExport(chosen.key)
          saveAs(new Blob([file.json], { type: "application/json" }), file.fileName)
          return
        }
        case "export-stored": {
          const file = await buildStoredAsFoundExport()
          saveAs(new Blob([file.json], { type: "application/json" }), file.fileName)
          return
        }
        case "restore":
          return restoreFromKeptCopy(chosen.key, EXTENSION_VERSION)
        case "delete":
          return deletePreservedById(chosen.key)
        case "defaults":
          return startFromDefaults(EXTENSION_VERSION)
        default:
          throw new Error("Unknown recovery action")
      }
    },
    onSuccess: (_result, chosen) => {
      toastManager.add({ type: "success", title: i18n.t(SUCCESS_KEYS[chosen.kind]) })
    },
    onError: (error, chosen) => {
      toastManager.add({
        type: "error",
        title: i18n.t(FAILURE_KEYS[chosen.kind]),
        // A fixed sentence for the kind of failure; the error's own message can quote stored values.
        description: recoveryFailureText(error),
      })
    },
    // The notice shows its own error toast with the reason; the global one would show a second.
    meta: { suppressToast: true },
  })

  if (!state || (state.copies.length === 0 && !state.storedUnusable)) return null

  const dialog = action ? DIALOGS[action.kind] : undefined

  return (
    <div
      id={RECOVERY_NOTICE_SECTION_ID}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      data-testid="recovery-notice"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {i18n.t(state.storedUnusable ? "recoveryExport.title" : "recoveryExport.copiesTitle")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {i18n.t(
            state.storedUnusable
              ? "recoveryExport.description"
              : "recoveryExport.copiesDescription",
          )}
        </p>
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => setAction({ kind: "export-kept", key: copy.key })}
            >
              {i18n.t("recoveryExport.exportCopy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => setAction({ kind: "restore", key: copy.key })}
            >
              {i18n.t("recoveryExport.tryRestore")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => setAction({ kind: "delete", key: copy.key })}
            >
              {i18n.t("recoveryExport.delete")}
            </Button>
          </div>
        </div>
      ))}

      {state.storedUnusable && (
        <>
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
              onClick={() => setAction({ kind: "export-stored" })}
            >
              {i18n.t("recoveryExport.exportStored")}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{i18n.t("recoveryExport.defaultsTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {i18n.t("recoveryExport.defaultsDescription")}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() => setAction({ kind: "defaults" })}
            >
              {i18n.t("recoveryExport.startFromDefaults")}
            </Button>
          </div>
        </>
      )}

      <AlertDialog
        open={action !== undefined}
        onOpenChange={(open) => !open && setAction(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog && i18n.t(`${dialog}.title`)}</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog && i18n.t(`${dialog}.description`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{i18n.t("recoveryExport.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={
                action?.kind === "defaults" || action?.kind === "delete" ? "destructive" : "default"
              }
              onClick={() => {
                if (action) run(action)
                setAction(undefined)
              }}
            >
              {dialog && i18n.t(`${dialog}.confirm`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const SUCCESS_KEYS = {
  "export-kept": "recoveryExport.saved",
  "export-stored": "recoveryExport.saved",
  restore: "recoveryExport.restored",
  delete: "recoveryExport.deleted",
  defaults: "recoveryExport.defaultsApplied",
} as const

const FAILURE_KEYS = {
  "export-kept": "recoveryExport.failed",
  "export-stored": "recoveryExport.failed",
  restore: "recoveryExport.restoreFailed",
  delete: "recoveryExport.deleteFailed",
  defaults: "recoveryExport.defaultsFailed",
} as const
