import type { Config } from "@/types/config/config"
import type { InitializeConfigResult } from "@/utils/config/init"
import { storage } from "#imports"
import { initializeConfig } from "@/utils/config/init"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"

let configPromise: Promise<InitializeConfigResult> | null = null

// To avoid background script initialize config simultaneously and avoid race condition
function initializeConfigOnce() {
  if (!configPromise) {
    configPromise = initializeConfig()
  }
  return configPromise
}

export async function ensureInitializedConfig() {
  await initializeConfigOnce()
  return storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
}

/**
 * Whether the config was created from defaults in this run, rather than loaded from storage.
 * Shares the memoized initialization above, so it never triggers a second init.
 */
export async function isFreshInstalledConfig() {
  return (await initializeConfigOnce()).isFreshInstall
}

/**
 * The memoized initialization result. `hadStoredConfig` describes storage as the first
 * initialization found it, so it holds no matter which caller got there first: the startup path
 * that fills in defaults usually runs before `onInstalled` is dispatched.
 */
export function getInitializeConfigResult() {
  return initializeConfigOnce()
}
