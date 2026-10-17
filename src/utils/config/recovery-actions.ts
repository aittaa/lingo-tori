import { replaceStoredConfig } from "@/utils/backup/current-config"
import { buildFreshDefaultConfig, CONFIG_SCHEMA_VERSION } from "../constants/config"
import { migrateConfig } from "./migration"
import { decodeLossless, listPreservedOriginals } from "./preservation"

/**
 * The user's way out when this version cannot use the stored settings. Both actions replace the
 * stored config through the settings service, which keeps an exact, confirmed copy of an unusable
 * stored config first (or backs up a usable one) and replaces nothing if that cannot be done.
 */

/** A kept copy could not be turned into settings; nothing was written. */
export class KeptCopyRestoreError extends Error {
  readonly code: "gone" | "unreadable"

  constructor(code: "gone" | "unreadable") {
    super(
      code === "gone"
        ? "That kept copy no longer exists, so nothing was restored."
        : "That kept copy could not be read back, so nothing was restored.",
    )
    this.name = "KeptCopyRestoreError"
    this.code = code
  }
}

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

  const config = await migrateConfig(value, labelOf(meta))
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
