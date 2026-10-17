import type { Config } from "@/types/config/config"
import type { ConfigMeta, ConfigValueAndMeta } from "@/types/config/meta"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_SCHEMA_VERSION, CONFIG_STORAGE_KEY } from "../constants/config"
import { logger } from "../logger"
import { assertConfigWritable, getConfigView } from "./status"

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

export async function setLocalConfig(config: Config) {
  const parsedConfig = configSchema.safeParse(config)
  if (!parsedConfig.success) {
    throw new Error("Config is invalid")
  }
  await assertConfigWritable()
  await storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, parsedConfig.data)
  await storage.setMeta<Partial<ConfigMeta>>(`local:${CONFIG_STORAGE_KEY}`, {
    lastModifiedAt: Date.now(),
  })
}

export async function getLocalConfigAndMeta(): Promise<ConfigValueAndMeta> {
  try {
    const [config, meta] = await Promise.all([
      storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`),
      storage.getMeta<ConfigMeta>(`local:${CONFIG_STORAGE_KEY}`),
    ])

    if (!config) {
      throw new Error("Local config not found")
    }

    const parsedConfig = configSchema.safeParse(config)
    if (!parsedConfig.success) {
      throw new Error("Local config is invalid")
    }

    return {
      value: parsedConfig.data,
      meta: {
        schemaVersion: meta?.schemaVersion ?? CONFIG_SCHEMA_VERSION,
        lastModifiedAt: meta?.lastModifiedAt ?? Date.now(),
      },
    }
  } catch (error) {
    logger.error("Failed to get local config", error)
    throw error
  }
}

export async function setLocalConfigAndMeta(config: Config, meta: Partial<ConfigMeta>) {
  const lastModifiedAt = meta.lastModifiedAt ?? Date.now()
  const parsedConfig = configSchema.safeParse(config)
  if (!parsedConfig.success) {
    throw new Error("Config is invalid")
  }
  await assertConfigWritable()
  await storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, parsedConfig.data)
  await storage.setMeta<Partial<ConfigMeta>>(`local:${CONFIG_STORAGE_KEY}`, {
    ...meta,
    lastModifiedAt,
  })
}
