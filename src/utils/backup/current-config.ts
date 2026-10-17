import type { Config } from "@/types/config/config"
import { ConfigRecoveryRequiredError, ConfigUpgradePendingError } from "@/utils/config/errors"
import { writePrimaryPair } from "@/utils/config/primary-write"
import { getConfigStatus } from "@/utils/config/status"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { addBackup, isSameAsLatestBackup } from "./storage"

/**
 * "Back up now": adds an ordinary backup of the config exactly as it is stored.
 *
 * The settings screens show the defaults when the stored config cannot be used, so a backup taken
 * from what the screen shows would store the defaults as the user's config. This reads the stored
 * pair instead, and refuses while it is not usable (the original is kept by the preservation store,
 * not by an ordinary backup) or has not been upgraded yet.
 */
export async function backUpCurrentConfig(extensionVersion: string): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") throw new ConfigRecoveryRequiredError(status.reason)
  if (status.kind === "upgrading") throw new ConfigUpgradePendingError()
  if (status.kind === "absent") throw new Error("There are no saved settings to back up.")
  await addBackup(status.raw.value as Config, extensionVersion, CONFIG_SCHEMA_VERSION)
}

/**
 * Replaces the stored config with `next` (a valid config the caller already migrated and checked),
 * for the actions where the user explicitly asks to: restore a backup, import a file, reset.
 *
 * A stored config that cannot be used is NOT replaced, and neither is one that has not been
 * upgraded yet (startup upgrades it; the action can be repeated once it has): the action is refused
 * and nothing is written. Replacing an unusable config needs a copy that is confirmed and a write
 * that cannot interleave with another one, which arrive with recovery in a later update.
 *
 * Otherwise, when `backupCurrent` is set, the usable stored config is first backed up exactly as
 * stored, unless the latest backup already holds exactly it. Then value and complete meta are
 * written in one call.
 */
export async function replaceStoredConfig(
  next: Config,
  options: { backupCurrent: boolean; extensionVersion: string },
): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") throw new ConfigRecoveryRequiredError(status.reason)
  if (status.kind === "upgrading") throw new ConfigUpgradePendingError()
  if (status.kind === "usable" && options.backupCurrent) {
    const current = status.raw.value as Config
    if (!(await isSameAsLatestBackup(current, CONFIG_SCHEMA_VERSION))) {
      await addBackup(current, options.extensionVersion, CONFIG_SCHEMA_VERSION)
    }
  }
  await writePrimaryPair(next)
}
