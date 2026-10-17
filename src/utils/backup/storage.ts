import type { ConfigBackup, ConfigBackupMetadata, ConfigBackupWithMetadata } from "@/types/backup"
import type { Config } from "@/types/config/config"
import { dequal } from "dequal"
import { storage } from "#imports"
import { BACKUP_ID_PREFIX, MAX_BACKUPS_COUNT } from "@/utils/constants/backup"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { logger } from "@/utils/logger"

/**
 * Generate a unique ID for a backup based on timestamp
 */
function generateBackupId(timestamp: number): string {
  const uuid = getRandomUUID()
  return `${BACKUP_ID_PREFIX}_${timestamp}_${uuid}`
}

/**
 * Get all backups sorted by timestamp (newest first)
 */
export async function getAllBackupsWithMetadata(): Promise<Array<ConfigBackupWithMetadata>> {
  const backupIds = (await storage.getItem<string[]>("local:backup_ids")) ?? []

  const backups: Array<ConfigBackupWithMetadata> = []

  for (const id of backupIds) {
    const backup = await storage.getItem<ConfigBackup>(`local:${id}`)
    const metadata = await storage.getMeta<ConfigBackupMetadata>(`local:${id}`)

    if (backup && metadata) {
      backups.push({ ...backup, metadata, id })
    }
  }

  // Sort by timestamp descending (newest first)
  return backups.sort((a, b) => b.metadata.createdAt - a.metadata.createdAt)
}

/**
 * Check if config is the same as the latest backup
 */
export async function isSameAsLatestBackup(
  config: Config,
  configSchemaVersion: number,
): Promise<boolean> {
  const backupsWithMetadata = await getAllBackupsWithMetadata()
  if (backupsWithMetadata.length === 0) {
    return false
  }

  const latestBackupWithMetadata = backupsWithMetadata[0]

  // Compare schema version
  if (latestBackupWithMetadata!.schemaVersion !== configSchemaVersion) {
    return false
  }

  return dequal(latestBackupWithMetadata!.config, config)
}

/**
 * The id of a backup made by the operation `opId`. It is derived from the operation, so a request
 * that is retried after a lost response finds the backup it already made instead of making another.
 */
export function backupIdFor(timestamp: number, opId: string): string {
  return `${BACKUP_ID_PREFIX}_${timestamp}_${opId}`
}

/** The backup an operation already made, if any (its id ends with the operation id). */
export async function findBackupMadeBy(opId: string): Promise<string | undefined> {
  const backupIds = (await storage.getItem<string[]>("local:backup_ids")) ?? []
  return backupIds.find((id) => id.endsWith(`_${opId}`))
}

export interface AddBackupOptions {
  /** Use this id instead of a new random one (see {@link backupIdFor}). */
  backupId?: string
  /** Set to false to leave rotation to a later {@link pruneBackups}. */
  prune?: boolean
}

/**
 * Add a new backup to storage and, unless told otherwise, remove the oldest ones beyond the limit.
 * The new entry is written before anything is removed, so an interruption never costs a backup
 * without having added the new one. Returns the id of the new backup.
 */
export async function addBackup(
  config: Config,
  extensionVersion: string,
  schemaVersion: number = CONFIG_SCHEMA_VERSION,
  options: AddBackupOptions = {},
): Promise<string> {
  try {
    const timestamp = Date.now()
    const backupId = options.backupId ?? generateBackupId(timestamp)

    // A backup carries the version its config is written for, so a restore migrates it correctly.
    const backup: ConfigBackup = {
      schemaVersion,
      config,
    }

    // Save the backup with metadata, then add it to the list (newest first).
    await storage.setItem(`local:${backupId}`, backup)
    await storage.setMeta(`local:${backupId}`, { createdAt: timestamp, extensionVersion })
    const backupIds = (await storage.getItem<string[]>("local:backup_ids")) ?? []
    await storage.setItem("local:backup_ids", [
      backupId,
      ...backupIds.filter((id) => id !== backupId),
    ])

    if (options.prune !== false) await pruneBackups()

    logger.info("Backup created:", backupId)
    return backupId
  } catch (error) {
    logger.error("Error adding backup:", error)
    throw error
  }
}

/** Remove the oldest backups beyond the limit. */
export async function pruneBackups(): Promise<void> {
  const backupIds = (await storage.getItem<string[]>("local:backup_ids")) ?? []
  if (backupIds.length <= MAX_BACKUPS_COUNT) return
  const kept = backupIds.slice(0, MAX_BACKUPS_COUNT)
  const removed = backupIds.slice(MAX_BACKUPS_COUNT)
  // The list stops naming them first, so a list never names an entry that was already removed.
  await storage.setItem("local:backup_ids", kept)
  await storage.removeItems(
    removed.map((id) => ({ key: `local:${id}` as const, options: { removeMeta: true } })),
  )
}

/** Remove a specific backup by id. Removing one that is already gone is not an error. */
export async function removeBackup(backupId: string): Promise<void> {
  try {
    const backupIds = (await storage.getItem<string[]>("local:backup_ids")) ?? []

    const updatedIds = backupIds.filter((id: string) => id !== backupId)
    await storage.setItem("local:backup_ids", updatedIds)
    await storage.removeItem(`local:${backupId}`, { removeMeta: true })

    logger.info("Backup removed:", backupId)
  } catch (error) {
    logger.error("Error removing backup:", error)
    throw error
  }
}

/**
 * Remove exactly the backups in `backupIds`. The list is fixed by the caller when the request is
 * made, so repeating the request never removes a backup that was added after it.
 */
export async function clearBackups(backupIds: readonly string[]): Promise<void> {
  try {
    const listed = (await storage.getItem<string[]>("local:backup_ids")) ?? []
    const remaining = listed.filter((id) => !backupIds.includes(id))
    if (remaining.length === 0) await storage.removeItem("local:backup_ids")
    else await storage.setItem("local:backup_ids", remaining)
    await storage.removeItems(
      backupIds.map((id) => ({ key: `local:${id}` as const, options: { removeMeta: true } })),
    )

    logger.info("Backups cleared:", backupIds.length)
  } catch (error) {
    logger.error("Error clearing backups:", error)
    throw error
  }
}

/** Clear all backups that exist now. */
export async function clearAllBackups(): Promise<void> {
  await clearBackups((await storage.getItem<string[]>("local:backup_ids")) ?? [])
}
