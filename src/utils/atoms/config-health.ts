import type { ConfigView, SuspectReason } from "../config/status"
import { atom } from "jotai"
import { getConfigView, watchConfigStatus } from "../config/status"

/**
 * What the settings screens need to tell the user about the stored config, in one place: the same
 * two atoms feed the banner in the options page and in the popup.
 *
 * - {@link configViewAtom}: the session view of the stored config, read when something mounts on it
 *   and followed through `watchConfigStatus` (validated reads, never the notification's payload).
 * - {@link configWriteFailureAtom}: why the last change a screen made was not saved, until the next
 *   change that is, or until the user dismisses it.
 */
export const configViewAtom = atom<ConfigView | null>(null)

configViewAtom.onMount = (set) => {
  let active = true
  // The first read and the watcher both publish a view, and a read can answer late. A view the
  // watcher has delivered is newer than any read that was still on its way, so such a read is
  // dropped instead of replacing it (otherwise the banner would vanish while every change is still
  // refused, or stay after the config is usable again). The watcher is subscribed first: whatever
  // changes after its baseline was read is delivered to it, so nothing can fall between that
  // baseline and the first read.
  let superseded = false
  const stop = watchConfigStatus((view) => {
    superseded = true
    if (active) set(view)
  })
  void getConfigView().then(
    (view) => {
      if (active && !superseded) set(view)
    },
    () => {
      // The next change notification reads again.
    },
  )
  return () => {
    active = false
    stop()
  }
}

/**
 * Why the stored config is not used, or `null` when it is (or nothing is stored, or it is only
 * waiting for startup to upgrade it, which resolves by itself).
 */
export const configUnusableReasonAtom = atom<SuspectReason | null>((get) => {
  const status = get(configViewAtom)?.status
  return status?.kind === "suspect" ? status.reason : null
})

export type ConfigWriteFailureKind =
  /** The change was not allowed (sender, field) or did not validate. */
  | "refused"
  /** The answer was lost and the retry could not tell whether the change was saved. */
  | "unknown-outcome"
  /** The part of the extension that saves settings could not be reached or could not save. */
  | "unavailable"
  /** Other changes kept arriving while this one was being saved. */
  | "conflict"
  /** The kept copy could not be made, so nothing was replaced. */
  | "preservation"
  | "other"

export interface ConfigWriteFailure {
  kind: ConfigWriteFailureKind
}

/**
 * The failure a screen should tell the user about, or `null` when the stored config being unusable
 * already says it (that state has its own banner and does not need one more line).
 */
export function describeWriteFailure(error: unknown): ConfigWriteFailure | null {
  const name = error instanceof Error ? error.name : ""
  switch (name) {
    case "ConfigRecoveryRequiredError":
      return null
    case "ConfigRefusedError":
      return { kind: "refused" }
    case "ConfigOutcomeUnknownError":
      return { kind: "unknown-outcome" }
    case "ConfigUnavailableError":
      return { kind: "unavailable" }
    case "ConfigConflictError":
      return { kind: "conflict" }
    case "PreservationError":
      return { kind: "preservation" }
    default:
      return { kind: "other" }
  }
}

export const configWriteFailureAtom = atom<ConfigWriteFailure | null>(null)
