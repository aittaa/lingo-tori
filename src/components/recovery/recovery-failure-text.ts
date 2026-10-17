import type { RecoveryFailureKind } from "@/utils/config/recovery-failure"
import { describeRecoveryFailure } from "@/utils/config/recovery-failure"
import { i18n } from "@/utils/i18n"

const KEYS = {
  invalid: "recoveryExport.failure.invalid",
  "newer-version": "recoveryExport.failure.newerVersion",
  unreadable: "recoveryExport.failure.unreadable",
  gone: "recoveryExport.failure.gone",
  "no-room": "recoveryExport.failure.noRoom",
  "not-kept": "recoveryExport.failure.notKept",
  unavailable: "recoveryExport.failure.unavailable",
  other: "recoveryExport.failure.other",
} as const satisfies Record<RecoveryFailureKind, string>

/**
 * The sentence a screen shows for a failed recovery action. It depends only on the kind of the
 * failure (see `describeRecoveryFailure`); the error's own message is never shown, so nothing the
 * stored settings contain can reach the screen through it.
 */
export function recoveryFailureText(error: unknown): string {
  return i18n.t(KEYS[describeRecoveryFailure(error)])
}
