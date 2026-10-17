import type { Config } from "@/types/config/config"
import { browser } from "#imports"
import { addBackup, isSameAsLatestBackup } from "@/utils/backup/storage"
import { getConfigStatus } from "@/utils/config/status"
import { EXTENSION_VERSION } from "@/utils/constants/app"
import { BACKUP_INTERVAL_MINUTES } from "@/utils/constants/backup"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { logger } from "@/utils/logger"

const CONFIG_BACKUP_ALARM = "config-backup"

export function setUpConfigBackup() {
  // Set up periodic alarm for config backup (only if it doesn't exist yet —
  // re-creating it on every service-worker start resets the timer, which
  // would wake the worker `delayInMinutes` later in a perpetual loop)
  void browser.alarms.get(CONFIG_BACKUP_ALARM).then((existingAlarm) => {
    if (!existingAlarm) {
      void browser.alarms.create(CONFIG_BACKUP_ALARM, {
        delayInMinutes: BACKUP_INTERVAL_MINUTES,
        periodInMinutes: BACKUP_INTERVAL_MINUTES,
      })
    }
  })

  // Listen for alarm events
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === CONFIG_BACKUP_ALARM) {
      await performAutoBackup()
    }
  })

  logger.info("Config auto-backup scheduled every", BACKUP_INTERVAL_MINUTES, "minutes")
}

async function performAutoBackup() {
  try {
    // Only a stored config that is usable as stored is backed up, and it is backed up as stored.
    // An unusable value is kept by the preservation store, never as an ordinary backup labelled
    // with the current version; a value still being upgraded is backed up once it has been.
    const status = await getConfigStatus()
    if (status.kind !== "usable") {
      logger.warn(`Skipping backup: the stored config is ${status.kind}`)
      return
    }
    const config = status.raw.value as Config

    if (await isSameAsLatestBackup(config, CONFIG_SCHEMA_VERSION)) {
      logger.info("Skipping backup: config is identical to latest backup")
      return
    }

    // Add backup
    await addBackup(config, EXTENSION_VERSION)

    logger.info("Auto backup completed successfully")
  } catch (error) {
    logger.error("Failed to perform auto backup:", error)
  }
}
