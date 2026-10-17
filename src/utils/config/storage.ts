import type { Config } from "@/types/config/config"
import { logger } from "../logger"
import { getConfigView } from "./status"
import { editConfig } from "./write-guard"

/**
 * The session's view of the stored config, read through the status reader: the parsed value when it
 * is usable, `null` when nothing is stored, and the defaults (in memory only, never stored) when
 * the stored value cannot be used.
 */
export async function getLocalConfig() {
  const { config, status } = await getConfigView()
  if (status.kind === "absent") {
    logger.warn("No config found in storage")
    return null
  }
  if (status.kind === "suspect") {
    logger.error(`Config is not usable (${status.reason}), using default config`)
  }
  return config
}

/**
 * Stores `config` as the whole config, through the settings service. Used by the page's own
 * shortcut, which holds the config it read a moment ago; the service refuses it if the stored
 * config cannot be used or has changed since.
 */
export async function setLocalConfig(config: Config) {
  await editConfig(() => config)
}
