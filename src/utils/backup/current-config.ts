import type { Config } from "@/types/config/config"
import { ConfigBackupBlockedError } from "@/utils/config/errors"
import { preserveOriginal } from "@/utils/config/preservation"
import { writePrimaryPair } from "@/utils/config/primary-write"
import { getConfigStatus } from "@/utils/config/status"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { addBackup, isSameAsLatestBackup } from "./storage"

/**
 * "Back up now": adds an ordinary backup of the config exactly as it is stored.
 *
 * The settings screens show the defaults when the stored config cannot be used, so a backup taken
 * from what the screen shows would store the defaults as the user's config. This reads the stored
 * pair instead, and refuses while it is not usable.
 */
export async function backUpCurrentConfig(extensionVersion: string): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") throw new ConfigBackupBlockedError(status.reason)
  if (status.kind === "absent") throw new ConfigBackupBlockedError("absent")
  const schemaVersion = status.kind === "upgrading" ? status.fromVersion : CONFIG_SCHEMA_VERSION
  await addBackup(status.raw.value as Config, extensionVersion, schemaVersion)
}

/**
 * Replaces the stored config with `next` (a valid config the caller already migrated and checked),
 * for the actions where the user explicitly asks to: restore a backup, import a file, reset.
 *
 * Before anything is written, the stored pair is dealt with by what it is:
 * - not usable: an exact copy is added to the preservation store and read back; if that cannot be
 *   done, nothing is replaced and the error reaches the caller. No ordinary backup is taken, since
 *   the settings screens' defaults are not the user's config;
 * - usable or being upgraded: when `backupCurrent` is set, it is backed up as stored (unless the
 *   latest backup already holds exactly it);
 * - nothing stored: nothing to keep.
 *
 * Then value and complete meta are written in one call.
 */
export async function replaceStoredConfig(
  next: Config,
  options: { backupCurrent: boolean; extensionVersion: string },
): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") {
    await preserveOriginal(status.raw, status.reason)
  } else if (status.kind === "usable" || status.kind === "upgrading") {
    if (options.backupCurrent) {
      const schemaVersion = status.kind === "upgrading" ? status.fromVersion : CONFIG_SCHEMA_VERSION
      const current = status.raw.value as Config
      if (!(await isSameAsLatestBackup(current, schemaVersion))) {
        await addBackup(current, options.extensionVersion, schemaVersion)
      }
    }
  }
  await writePrimaryPair(next)
}
