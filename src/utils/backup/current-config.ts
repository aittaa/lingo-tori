import type { Config } from "@/types/config/config"
import { backUpNow, replaceConfig } from "@/utils/config/write-guard"

/**
 * "Back up now": adds an ordinary backup of the config exactly as it is stored.
 *
 * The settings screens show the defaults when the stored config cannot be used, so a backup taken
 * from what the screen shows would store the defaults as the user's config. The settings service
 * reads the stored pair itself, inside its queue, and refuses while it is not usable (the original
 * is kept by the preservation store, not by an ordinary backup).
 */
export async function backUpCurrentConfig(extensionVersion: string): Promise<void> {
  await backUpNow(extensionVersion)
}

/**
 * Replaces the stored config with `next` (a valid config the caller already migrated and checked),
 * for the actions where the user explicitly asks to: restore a backup, import a file, reset.
 *
 * The settings service does it in one queued job. With `backupCurrent`, a usable config is first
 * backed up exactly as stored (unless the latest backup already holds it); a config that cannot be
 * used is instead kept as an exact, confirmed copy, and nothing is replaced if that fails. Then the
 * value and its complete meta are committed together. A replacement that does not happen leaves the
 * backup list as it was.
 */
export async function replaceStoredConfig(
  next: Config,
  options: { backupCurrent: boolean; extensionVersion: string },
): Promise<void> {
  await replaceConfig(next, options)
}
