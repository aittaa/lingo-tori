import type { Config } from "./config/config"

export interface ConfigBackup {
  schemaVersion: number
  config: Config
}

export interface ConfigBackupMetadata extends Record<string, unknown> {
  createdAt: number
  extensionVersion: string
  /** The digest of the settings-service operation that made this backup, when one did. */
  opDigest?: string
}

export interface ConfigBackupWithMetadata extends ConfigBackup {
  metadata: ConfigBackupMetadata
  id: string
}
