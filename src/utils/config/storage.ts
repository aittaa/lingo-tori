import { logger } from "../logger"
import { getConfigView } from "./status"

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
