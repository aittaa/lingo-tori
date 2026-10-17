import { replaceStoredConfig } from "@/utils/backup/current-config"
import { buildFreshDefaultConfig, CONFIG_SCHEMA_VERSION } from "../constants/config"
import { ConfigVersionTooNewError, KeptCopyRestoreError } from "./errors"
import { migrateConfig } from "./migration"
import { decodeLossless, listPreservedOriginals } from "./preservation"

export { KeptCopyRestoreError }

/**
 * The user's way out when this version cannot use the stored settings. Both actions replace the
 * stored config through the settings service, which keeps an exact, confirmed copy of an unusable
 * stored config first (or backs up a usable one) and replaces nothing if that cannot be done.
 */

function labelOf(meta: unknown): number {
  if (typeof meta === "object" && meta !== null) {
    const version = (meta as { schemaVersion?: unknown }).schemaVersion
    if (typeof version === "number" && Number.isInteger(version) && version >= 1) return version
  }
  // A copy whose meta had no readable label is taken as written for this version.
  return CONFIG_SCHEMA_VERSION
}

/**
 * Tries the settings in a kept copy: reads the copy back exactly, upgrades it from the version its
 * own meta names and validates it. Only a result that validates is written; any failure (a copy
 * from a newer version, a value that still fails the schema after the upgrade, a failed upgrade
 * step) is thrown and writes nothing. The settings that are stored now are backed up first when
 * they are usable, and kept as an exact copy first when they are not.
 *
 * What a failure carries is a type, never the copy's content: the message of a validation error
 * quotes the values it rejected, so it is neither passed on nor logged here.
 */
export async function restoreFromKeptCopy(key: string, extensionVersion: string): Promise<void> {
  const kept = (await listPreservedOriginals()).find((item) => item.key === key)
  if (!kept) throw new KeptCopyRestoreError("gone")

  let value: unknown
  let meta: unknown
  try {
    value = decodeLossless(kept.entry.encodedValue)
    meta = kept.entry.encodedMeta === undefined ? undefined : decodeLossless(kept.entry.encodedMeta)
  } catch {
    throw new KeptCopyRestoreError("unreadable")
  }

  let config: Awaited<ReturnType<typeof migrateConfig>>
  try {
    config = await migrateConfig(value, labelOf(meta))
  } catch (error) {
    if (error instanceof ConfigVersionTooNewError) throw error
    throw new KeptCopyRestoreError("invalid")
  }
  await replaceStoredConfig(config, { backupCurrent: true, extensionVersion })
}

/**
 * Starts from the default settings. The stored config is not lost: an unusable one is kept as an
 * exact copy first (and the replacement is refused if that copy cannot be made), a usable one is
 * backed up.
 */
export async function startFromDefaults(extensionVersion: string): Promise<void> {
  await replaceStoredConfig(buildFreshDefaultConfig(), { backupCurrent: true, extensionVersion })
}
