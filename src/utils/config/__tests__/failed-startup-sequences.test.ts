// What the actions do AFTER a startup that could not upgrade a stored config.
//
// A stored config with an older version label is "upgrading" until startup has migrated it. When
// startup cannot (a step throws, or the migrated value still fails the schema) it leaves the pair as
// it is and keeps an exact copy; the label stays old. Every reader that runs later must see that as
// an unusable config, not as an upgrade that is merely still pending, and every action that would
// replace, back up or export the stored config must refuse, exactly as it does for any other
// config that cannot be used. The same actions are refused while the upgrade has not run at all.
//
// Real code: `initializeConfig`, the migration chain, the status reader, `replaceStoredConfig`,
// `backUpCurrentConfig`, `assertCurrentConfigExportable`, over the extension's in-memory browser
// storage. The only stand-in is the `runMigration` hook.

import type { RawPrimary } from "./preservation-test-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backUpCurrentConfig, replaceStoredConfig } from "@/utils/backup/current-config"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import {
  ConfigExportBlockedError,
  ConfigRecoveryRequiredError,
  ConfigUpgradePendingError,
} from "../errors"
import { assertCurrentConfigExportable, getConfigStatus } from "../status"
import {
  backupEntries,
  preservedCopiesOf,
  PREVIOUS_META,
  previousVersionConfig,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  snapshot,
  validConfig,
} from "./preservation-test-kit"

const migration = vi.hoisted(() => ({
  hook: null as
    | null
    | ((
        version: number,
        config: any,
        real: (version: number, config: any) => Promise<any>,
      ) => Promise<any>),
}))

vi.mock("../migration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../migration")>()
  return {
    ...actual,
    runMigration: (version: number, config: any) =>
      migration.hook
        ? migration.hook(version, config, actual.runMigration)
        : actual.runMigration(version, config),
  }
})

async function startBackground() {
  vi.resetModules()
  const { initializeConfig } = await import("../init")
  return initializeConfig()
}

beforeEach(() => {
  resetStorage()
  migration.hook = null
})

afterEach(() => {
  migration.hook = null
})

const OPTIONS = { extensionVersion: "0.0.1" }

function replacement() {
  const next = validConfig()
  next.contextMenu.enabled = false
  return next
}

const FAILURES = [
  {
    name: "a migration step throws",
    reason: "migration-failed",
    prepare: () => {
      migration.hook = async (version, config, real) => {
        if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
        return real(version, config)
      }
    },
    original: (): RawPrimary => ({ value: previousVersionConfig(), meta: PREVIOUS_META }),
  },
  {
    name: "the upgraded value still fails the schema (the real upgrade runs)",
    reason: "invalid-schema",
    prepare: () => {},
    original: (): RawPrimary => ({
      value: { ...previousVersionConfig(), contextMenu: { enabled: "yes" } },
      meta: PREVIOUS_META,
    }),
  },
] as const

describe.each(FAILURES)("after a startup where $name", ({ reason, prepare, original }) => {
  let kept: RawPrimary

  beforeEach(async () => {
    kept = original()
    await seedPrimary(kept.value, kept.meta)
    prepare()
    await startBackground()
  })

  it("leaves the pair as it was, with one exact copy of it", async () => {
    expect(sameRaw(await readRawPrimary(), kept)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), kept)).toHaveLength(1)
  })

  it("reads the stored config as unusable for the reason startup recorded, not as an upgrade", async () => {
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason })
  })

  it.each([true, false])(
    "refuses to replace it (backupCurrent: %s), and writes nothing",
    async (backupCurrent) => {
      const before = await snapshot()

      await expect(
        replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
      ).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

      expect(await snapshot()).toEqual(before)
    },
  )

  it("refuses Back up now, and adds no backup", async () => {
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

    expect(await snapshot()).toEqual(before)
    expect(backupEntries(await snapshot())).toEqual([])
  })

  it("refuses to export it as the current settings", async () => {
    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason })
  })
})

describe("before startup has upgraded a stored config", () => {
  beforeEach(async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
  })

  it.each([true, false])(
    "refuses to replace it (backupCurrent: %s) with a retryable error, and writes nothing",
    async (backupCurrent) => {
      const before = await snapshot()

      await expect(
        replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
      ).rejects.toBeInstanceOf(ConfigUpgradePendingError)

      expect(await snapshot()).toEqual(before)
    },
  )

  it("refuses Back up now with a retryable error, and adds no backup", async () => {
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigUpgradePendingError)

    expect(await snapshot()).toEqual(before)
  })

  it("refuses to export it as the current settings", async () => {
    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason: "upgrading" })
  })
})

describe("controls: a startup that does upgrade the stored config", () => {
  beforeEach(async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    await startBackground()
  })

  it("leaves a usable config, and the actions are allowed again", async () => {
    expect((await getConfigStatus()).kind).toBe("usable")
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()

    await backUpCurrentConfig("0.0.1")
    await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: true })

    expect(backupEntries(await snapshot()).length).toBeGreaterThan(0)
    expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(false)
  })
})

describe("a later start, once the step works", () => {
  it("upgrades the config that an earlier start could not, and the actions are allowed", async () => {
    const original: RawPrimary = { value: previousVersionConfig(), meta: PREVIOUS_META }
    await seedPrimary(original.value, original.meta)
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }
    await startBackground()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })

    migration.hook = null
    await startBackground()

    expect((await getConfigStatus()).kind).toBe("usable")
    // The earlier copy stays: nothing deletes a kept original on its own.
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()
  })
})
