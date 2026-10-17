/**
 * What went wrong in a recovery action (export, restore, delete, start from the defaults), as a
 * kind with no content: the screens show a fixed sentence per kind and never the message of the
 * error, because the message of a validation error quotes the stored values it rejected.
 *
 * - `invalid`: the kept copy does not pass this version's checks, or could not be upgraded.
 * - `newer-version`: the kept copy was saved by a newer version.
 * - `unreadable`: the kept copy's text could not be read back.
 * - `gone`: the kept copy no longer exists.
 * - `no-room`: too many unusable settings are already kept to keep another before replacing.
 * - `not-kept`: a copy of the saved settings could not be made or confirmed first.
 * - `unavailable`: the part that saves settings could not finish; the settings may or may not have
 *   changed.
 * - `other`: anything else.
 */
export type RecoveryFailureKind =
  | "invalid"
  | "newer-version"
  | "unreadable"
  | "gone"
  | "no-room"
  | "not-kept"
  | "unavailable"
  | "other"

/** The kind of a failure, read from the error's type and code only, never from its text. */
export function describeRecoveryFailure(error: unknown): RecoveryFailureKind {
  if (!(error instanceof Error)) return "other"
  const code = (error as { code?: unknown }).code
  switch (error.name) {
    case "KeptCopyRestoreError":
      return code === "gone" || code === "unreadable" || code === "invalid" ? code : "other"
    case "ConfigVersionTooNewError":
      return "newer-version"
    case "PreservationError":
      return code === "full" ? "no-room" : "not-kept"
    case "ConfigUnavailableError":
    case "ConfigOutcomeUnknownError":
    case "ConfigConflictError":
      return "unavailable"
    default:
      return "other"
  }
}
