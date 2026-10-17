import type { InitFailureReason } from "./init-failure"
import type { RawConfigPair, SuspectReason } from "./status"
import type { Config } from "@/types/config/config"
import { configSchema } from "@/types/config/config"
import { isAPIProviderConfig } from "@/types/config/provider"
import { initI18n } from "@/utils/i18n"
import { buildFreshDefaultConfig, CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "../constants/config"
import { logger } from "../logger"
import { clearInitFailure, recordInitFailure } from "./init-failure"
import { runMigration } from "./migration"
import { preserveOriginal } from "./preservation"
import { commitPrimary, commitPrimaryMeta } from "./primary-write"
import { classifyConfigPair, readModifiedAt, readRawConfigPair } from "./status"

export interface InitializeConfigResult {
  /**
   * The config was created from defaults in this run because nothing was stored. Callers use it
   * to run one-time setup that only makes sense on untouched defaults (see
   * `selectFreshTranslateProviders`). A stored value that cannot be used is never rebuilt, so it
   * is not a fresh install.
   */
  isFreshInstall: boolean
  /**
   * Storage held a config value before this run touched it. Unlike `isFreshInstall` it stays false
   * only for a profile that had nothing at all - a value that cannot be used still reports true -
   * so first-run work that must never reach an existing user (see the onboarding lifecycle) can
   * key on it.
   */
  hadStoredConfig: boolean
}

/**
 * Best effort and repeated on every start: a stored config that cannot be used is kept exactly
 * as it is, and an exact copy is added to the preservation store. If the copy cannot be made now
 * (no space, a failed write) the stored value is still not touched, and the next start tries again.
 */
async function keepOriginal(raw: RawConfigPair, reason: SuspectReason) {
  try {
    await preserveOriginal(raw, reason)
  } catch (error) {
    logger.error("Could not keep a copy of the stored config; leaving it as it is", error)
  }
}

/** The operation id startup's commits carry. */
const BOOTSTRAP_OP = "bootstrap"

type MigrationOutcome =
  | { kind: "migrated"; config: Config }
  | { kind: "failed"; reason: InitFailureReason }

/**
 * Runs the migration steps over a COPY of the stored value, so what is stored stays exactly as
 * read. The first step that throws stops the chain: nothing after it runs, and nothing is advanced.
 */
async function migrateStoredValue(
  raw: RawConfigPair,
  fromVersion: number,
): Promise<MigrationOutcome> {
  let working: unknown
  try {
    working = structuredClone(raw.value)
    for (let version = fromVersion + 1; version <= CONFIG_SCHEMA_VERSION; version++) {
      working = await runMigration(version, working)
    }
  } catch (error) {
    logger.error("Config migration failed; the stored config is left as it is", error)
    return { kind: "failed", reason: "migration-failed" }
  }

  const parsed = configSchema.safeParse(working)
  if (!parsed.success) return { kind: "failed", reason: "invalid-schema" }
  return { kind: "migrated", config: parsed.data }
}

/**
 * Initialize the config, this function should only be called once in the background script.
 *
 * A stored config that startup cannot use - one that fails its schema, whose migration throws,
 * that is labelled by a newer version, or whose meta cannot be read - is an original. Startup
 * keeps it exactly where it is, adds an exact copy to the preservation store, writes nothing to
 * `local:config` or its meta, and lets the session run on the defaults in memory.
 *
 * When the migration of an older-labelled config fails, the outcome is also recorded for that exact
 * pair (see `init-failure.ts`), so that readers do not describe a completed failed upgrade as a
 * pending one even when no copy could be kept.
 *
 * A usable or successfully migrated config keeps its previous behaviour: it is written (value and
 * complete meta in one call) only when something changed.
 */
export async function initializeConfig(): Promise<InitializeConfigResult> {
  const raw = await readRawConfigPair()
  const status = classifyConfigPair(raw)
  // A corrupted falsy value (false, 0, "") was still written by somebody, so it counts as stored.
  const hadStoredConfig = raw.hasValue

  if (status.kind === "suspect") {
    await keepOriginal(raw, status.reason)
    // Nothing is waiting for an upgrade: an earlier failed one is not about this pair.
    await clearInitFailure()
    return { isFreshInstall: false, hadStoredConfig }
  }

  let config: Config
  if (status.kind === "absent") {
    // Initialize locale before building defaults used by this browser context.
    await initI18n(DEFAULT_CONFIG.uiLanguage)
    config = buildFreshDefaultConfig()
  } else if (status.kind === "usable") {
    config = status.config
  } else {
    const outcome = await migrateStoredValue(raw, status.fromVersion)
    if (outcome.kind === "failed") {
      await keepOriginal(raw, outcome.reason)
      // Whether or not a copy could be kept, this completed start did not upgrade this pair: say so
      // for readers (see `init-failure.ts`).
      await recordInitFailure(raw, outcome.reason)
      return { isFreshInstall: false, hadStoredConfig }
    }
    config = outcome.config
  }
  // A usable pair or none has no failed upgrade pending. An upgraded pair is only the pair that
  // failed until it is stored: its record is dropped after the write below, not before it.
  if (status.kind !== "upgrading") await clearInitFailure()

  let didConfigChange = status.kind === "absent" || status.kind === "upgrading"

  if (import.meta.env.DEV) {
    const apiKeyResult = applyAPIKeysFromEnv(config)
    config = apiKeyResult.config
    didConfigChange = didConfigChange || apiKeyResult.changed

    const betaResult = applyDevBetaExperience(config)
    config = betaResult.config
    didConfigChange = didConfigChange || betaResult.changed
  }

  const lastModifiedAt = readModifiedAt(raw)
  const context = { previous: raw, opId: BOOTSTRAP_OP, opDigest: BOOTSTRAP_OP, lastModifiedAt }
  if (didConfigChange) {
    await commitPrimary(config, context)
  } else if (
    status.kind === "usable" &&
    (status.metaMissing || lastModifiedAt === undefined || status.valueDigest === undefined)
  ) {
    // A config written before revisions and digests existed gets them now, without a change to
    // the user's data.
    await commitPrimaryMeta(context)
  }

  // The record clears only once the upgraded pair is persisted: a write that throws leaves the pair
  // that failed in place, and it must keep reading as a failed upgrade.
  if (status.kind === "upgrading") await clearInitFailure()

  return { isFreshInstall: status.kind === "absent", hadStoredConfig }
}

function applyAPIKeysFromEnv(config: Config): { config: Config; changed: boolean } {
  let changed = false

  const providersConfig = config.providersConfig.map((providerConfig) => {
    if (!isAPIProviderConfig(providerConfig)) {
      return providerConfig
    }

    const apiKeyEnvName = `WXT_${providerConfig.provider.toUpperCase()}_API_KEY`
    const envApiKey = import.meta.env[apiKeyEnvName] as string | undefined
    if (!envApiKey || providerConfig.apiKey === envApiKey) {
      return providerConfig
    }

    changed = true
    return {
      ...providerConfig,
      apiKey: envApiKey,
    }
  })

  if (!changed) {
    return { config, changed: false }
  }

  return {
    config: {
      ...config,
      providersConfig,
    },
    changed: true,
  }
}

function applyDevBetaExperience(config: Config): { config: Config; changed: boolean } {
  if (config.betaExperience.enabled) {
    return { config, changed: false }
  }

  return {
    config: {
      ...config,
      betaExperience: {
        ...config.betaExperience,
        enabled: true,
      },
    },
    changed: true,
  }
}
