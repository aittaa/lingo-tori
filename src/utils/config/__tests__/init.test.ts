import type { Config } from "@/types/config/config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isAPIProviderConfig } from "@/types/config/provider"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { digestOfStoredValue } from "../status"
import {
  ABSENT,
  committedMeta,
  CURRENT_META,
  readPreserved,
  readRawPrimary,
  resetStorage,
  seedPrimary,
  trackPrimaryWrites,
} from "./preservation-test-kit"

// Startup is driven over the extension's in-memory browser storage; only the migration step is a
// stand-in, so that a test decides what it returns. What startup does to a config it cannot use is
// covered in `original-preservation-init.test.ts`.
const runMigrationMock = vi.fn<(...args: any[]) => any>()

vi.mock("../migration", () => ({
  runMigration: runMigrationMock,
}))

function buildStableConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  // In DEV mode, beta experience is enabled. Keep it true so no extra write is introduced.
  config.betaExperience.enabled = true
  config.providersConfig = config.providersConfig.map((providerConfig) => {
    if (!isAPIProviderConfig(providerConfig)) {
      return providerConfig
    }

    const apiKeyEnvName = `WXT_${providerConfig.provider.toUpperCase()}_API_KEY`
    const envApiKey = import.meta.env[apiKeyEnvName] as string | undefined
    if (!envApiKey) {
      return providerConfig
    }

    return {
      ...providerConfig,
      apiKey: envApiKey,
    }
  })
  return config
}

const UP_TO_DATE_META = { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: 123 }

describe("initializeConfig", () => {
  beforeEach(() => {
    vi.resetModules()
    resetStorage()
    runMigrationMock.mockReset()
    runMigrationMock.mockImplementation(async (_nextVersion: number, config: Config) => config)
  })

  async function initialize() {
    const { initializeConfig } = await import("../init")
    return initializeConfig()
  }

  function translateProviderIdsOf(config: Config) {
    return [
      config.pageTranslation.providerId,
      config.selectionToolbar.features.translate.providerId,
      config.videoSubtitles.providerId,
    ]
  }

  it("does not write when config and meta are already up to date", async () => {
    const config = buildStableConfig()
    await seedPrimary(config, committedMeta(config))
    const tracker = trackPrimaryWrites()

    await initialize()

    expect(runMigrationMock).not.toHaveBeenCalled()
    expect(tracker.writes).toEqual([])
  })

  it("gives a config written before revisions existed its revision and digest, without touching the value", async () => {
    const config = buildStableConfig()
    await seedPrimary(config, UP_TO_DATE_META)
    const tracker = trackPrimaryWrites()

    await initialize()

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(config)
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 123,
      revision: 1,
      valueDigest: digestOfStoredValue(config),
    })
  })

  it("writes config and meta, in one call, when config is missing", async () => {
    const tracker = trackPrimaryWrites()

    await initialize()

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config", "config$"] }])
    const stored = await readRawPrimary()
    expect((stored.value as Config).providersConfig).toEqual([])
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: expect.any(Number),
      revision: 1,
      lastOpId: "bootstrap",
      valueDigest: digestOfStoredValue(stored.value),
    })
  })

  it("starts every translate feature unconfigured", async () => {
    const { isFreshInstall } = await initialize()

    expect(isFreshInstall).toBe(true)
    expect(translateProviderIdsOf((await readRawPrimary()).value as Config)).toEqual([
      "unconfigured",
      "unconfigured",
      "unconfigured",
    ])
  })

  it("does not report a fresh install when a stored config is reused", async () => {
    await seedPrimary(buildStableConfig(), UP_TO_DATE_META)

    const { isFreshInstall } = await initialize()

    expect(isFreshInstall).toBe(false)
  })

  it("does not rebuild an unparseable config, so it is not reported as a fresh install, and is reported as stored", async () => {
    await seedPrimary({ not: "a config" }, CURRENT_META)

    const result = await initialize()

    expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
    expect((await readRawPrimary()).value).toEqual({ not: "a config" })
  })

  it("reports that storage held no config only when nothing was stored", async () => {
    const { hadStoredConfig } = await initialize()

    expect(hadStoredConfig).toBe(false)
  })

  it("reports a reused config as stored", async () => {
    await seedPrimary(buildStableConfig(), UP_TO_DATE_META)

    const { hadStoredConfig } = await initialize()

    expect(hadStoredConfig).toBe(true)
  })

  // The stored values false and "" with no meta are pinned, with the same assertions, by the cases
  // of original-preservation-init.test.ts; 0 with no meta is the one state that file does not seed.
  it("counts a corrupted falsy stored value 0 as an existing config and keeps it as it is", async () => {
    await seedPrimary(0, ABSENT)
    const tracker = trackPrimaryWrites()

    const result = await initialize()

    expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
    expect(tracker.writes).toEqual([])
    expect((await readRawPrimary()).value).toBe(0)
    expect(await readPreserved()).toHaveLength(1)
  })

  it("treats a key that was never stored as absence", async () => {
    const result = await initialize()

    expect(result).toEqual({ isFreshInstall: true, hadStoredConfig: false })
  })

  it("runs migration and persists the migrated config once, with its meta in the same call", async () => {
    const config = buildStableConfig()
    const migrated = {
      ...config,
      contextMenu: {
        ...config.contextMenu,
        enabled: false,
      },
    }
    await seedPrimary(config, { schemaVersion: CONFIG_SCHEMA_VERSION - 1, lastModifiedAt: 888 })
    runMigrationMock.mockResolvedValueOnce(migrated)
    const tracker = trackPrimaryWrites()

    await initialize()

    expect(runMigrationMock).toHaveBeenCalledWith(CONFIG_SCHEMA_VERSION, config)
    expect(tracker.writes).toEqual([{ method: "set", keys: ["config", "config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(migrated)
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 888,
      revision: 1,
      valueDigest: digestOfStoredValue(migrated),
    })
  })

  it("stores the migrated config as parsed, with the toolbar's order and pins in step", async () => {
    const config = buildStableConfig()
    const migrated = {
      ...config,
      selectionToolbar: {
        ...config.selectionToolbar,
        order: ["speak", "gone"],
        unpinned: ["gone", "speak"],
      },
    }
    await seedPrimary(config, { schemaVersion: CONFIG_SCHEMA_VERSION - 1, lastModifiedAt: 888 })
    runMigrationMock.mockResolvedValueOnce(migrated)

    await initialize()

    const stored = (await readRawPrimary()).value as Config
    expect(stored.selectionToolbar.order).toEqual([
      "translate",
      "default-dictionary",
      "default-sentence-analysis",
    ])
    expect(stored.selectionToolbar.unpinned).toEqual([])
  })

  it("only updates meta when config is unchanged but lastModifiedAt is missing", async () => {
    const config = buildStableConfig()
    await seedPrimary(config, { schemaVersion: CONFIG_SCHEMA_VERSION })
    const tracker = trackPrimaryWrites()

    await initialize()

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(config)
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: expect.any(Number),
      revision: 1,
    })
  })
})
