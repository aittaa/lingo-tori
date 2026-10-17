export class ConfigVersionTooNewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigVersionTooNewError"
  }
}

/**
 * "Export my current settings" was refused because the stored config is not usable: the settings
 * screens would export their defaults, which are not the user's settings.
 */
export class ConfigExportBlockedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(
      "The stored settings cannot be read, so nothing was exported. Your original settings are " +
        "kept as they are; export that copy from the settings recovery options instead.",
    )
    this.name = "ConfigExportBlockedError"
    this.reason = reason
  }
}
