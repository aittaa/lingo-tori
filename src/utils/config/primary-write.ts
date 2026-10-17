import type { Config } from "@/types/config/config"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_SCHEMA_VERSION, CONFIG_STORAGE_KEY } from "../constants/config"
import { CONFIG_META_STORAGE_KEY } from "./status"

/** The complete meta a write leaves next to the value. It replaces the old meta; nothing is merged. */
export interface PrimaryMeta {
  schemaVersion: number
  lastModifiedAt: number
}

function currentMeta(lastModifiedAt: number | undefined): PrimaryMeta {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: lastModifiedAt ?? Date.now() }
}

/**
 * Stores a valid config and its complete meta in ONE `storage.local.set` call carrying both keys,
 * so the value and its version label are not written one after the other. That narrows the window
 * in which a restart can see a value with a stale label; it does not claim the browser makes the
 * write atomic.
 *
 * Only startup and the explicit replace actions (restore, import, reset) use this. A config that
 * does not validate is refused here, so the stored pair never becomes invalid by this function.
 */
export async function writePrimaryPair(
  config: Config,
  options: { lastModifiedAt?: number } = {},
): Promise<void> {
  if (!configSchema.safeParse(config).success) throw new Error("Config is invalid")
  await browser.storage.local.set({
    [CONFIG_STORAGE_KEY]: config,
    [CONFIG_META_STORAGE_KEY]: currentMeta(options.lastModifiedAt),
  })
}

/** Writes only the meta, for a stored value that is valid but has no usable label or time. */
export async function writePrimaryMeta(options: { lastModifiedAt?: number } = {}): Promise<void> {
  await browser.storage.local.set({
    [CONFIG_META_STORAGE_KEY]: currentMeta(options.lastModifiedAt),
  })
}
