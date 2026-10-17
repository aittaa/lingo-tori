export class ConfigVersionTooNewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigVersionTooNewError"
  }
}

/**
 * "Export my current settings" was refused because the stored config is not usable (or has not been
 * upgraded yet): the settings screens would export their defaults, which are not the user's
 * settings. `reason` is why the stored config is not usable, or "upgrading".
 */
export class ConfigExportBlockedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(
      reason === "upgrading"
        ? "The stored settings are still being upgraded to this version, so nothing was exported. " +
            "Try again in a moment."
        : "The stored settings cannot be read by this version, so nothing was exported. They are " +
            "kept as they are. Save them exactly as stored with the recovery export in the " +
            "settings page or on the error screen.",
    )
    this.name = "ConfigExportBlockedError"
    this.reason = reason
  }
}

export type PreservationFailure = "full" | "unrepresentable" | "write-failed" | "verify-failed"

/**
 * A stored config that cannot be used could not be kept, or its copy could not be confirmed.
 * Whatever needed the copy stops: the stored value is never replaced without one.
 */
export class PreservationError extends Error {
  readonly code: PreservationFailure

  constructor(code: PreservationFailure, options?: { cause?: unknown }) {
    super(
      {
        full: "Too many unusable settings copies are already kept; delete one before another is kept.",
        unrepresentable: "The stored settings contain a value that cannot be kept exactly.",
        "write-failed": "The copy of the stored settings could not be written.",
        "verify-failed":
          "The copy of the stored settings could not be confirmed after it was written.",
      }[code],
      options,
    )
    this.name = "PreservationError"
    this.code = code
  }
}

/**
 * A change to the config was refused because the stored config cannot be used (it fails its
 * schema, a migration failed, it is labelled by a newer version, or its meta cannot be read).
 * Nothing was written: the stored value stays exactly as it is, and the original is kept.
 * Replacing an unusable config is not available yet; it arrives with recovery in a later update.
 */
export class ConfigRecoveryRequiredError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(
      "Your saved settings cannot be read by this version, so nothing was changed. They are kept " +
        "exactly as they are, and you can save them with the recovery export in the settings page. " +
        "Restoring them is not available yet and arrives in a later update.",
    )
    this.name = "ConfigRecoveryRequiredError"
    this.reason = reason
  }
}

/** A change was refused for a reason that is not the state of the stored config (see `reason`). */
export class ConfigRefusedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`This change was not allowed (${reason}). Nothing was changed.`)
    this.name = "ConfigRefusedError"
    this.reason = reason
  }
}

/** Another context changed the settings again and again while this change was being saved. */
export class ConfigConflictError extends Error {
  constructor() {
    super(
      "The settings kept changing while this was being saved, so nothing was changed. Try again.",
    )
    this.name = "ConfigConflictError"
  }
}

/** The part of the extension that saves settings could not be reached or could not save. */
export class ConfigUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The settings could not be saved right now. They may or may not have been changed.",
      options,
    )
    this.name = "ConfigUnavailableError"
  }
}

/**
 * A request was repeated after its answer was lost and it cannot be told whether the first attempt
 * happened. It is not repeated again; the settings screen shows what is stored now.
 */
export class ConfigOutcomeUnknownError extends Error {
  constructor() {
    super("It is not known whether the change was saved. Check the settings, then try again.")
    this.name = "ConfigOutcomeUnknownError"
  }
}
