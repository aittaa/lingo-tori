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

/** A change was refused because the stored config is still being upgraded; it is worth retrying. */
export class ConfigUpgradePendingError extends Error {
  constructor() {
    super(
      "Your saved settings are still being upgraded to this version, so nothing was changed. " +
        "Try again in a moment.",
    )
    this.name = "ConfigUpgradePendingError"
  }
}
