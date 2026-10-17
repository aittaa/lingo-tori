import type { InitializeConfigResult } from "@/utils/config/init"
import { initializeConfig } from "@/utils/config/init"
import { getLocalConfig } from "@/utils/config/storage"

let configPromise: Promise<InitializeConfigResult> | null = null

// To avoid background script initialize config simultaneously and avoid race condition
function initializeConfigOnce() {
  if (!configPromise) {
    configPromise = initializeConfig()
  }
  return configPromise
}

/**
 * Waits for startup, then returns the session's view of the config: the stored value when it is
 * usable, the defaults when the stored value cannot be used (it stays stored, untouched), and
 * `null` only if nothing could be stored.
 */
export async function ensureInitializedConfig() {
  await initializeConfigOnce()
  return getLocalConfig()
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
