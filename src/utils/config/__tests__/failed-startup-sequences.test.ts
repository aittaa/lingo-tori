// What the actions do AFTER a startup that could not upgrade a stored config.
//
// A stored config with an older version label is "upgrading" until startup has migrated it. When
// startup cannot (a step throws, or the migrated value still fails the schema) it leaves the pair as
// it is and keeps an exact copy; the label stays old. Every reader that runs later must see that as
// an unusable config, not as an upgrade that is merely still pending. Restoring, importing or
// resetting is then the user's explicit way out: it keeps the exact copy (the one startup made, not
// a second one) and replaces the pair, while Back up now and exporting the current settings refuse,
// as they do for any other config that cannot be used.
//
// Real code: `initializeConfig`, the migration chain, the status reader, the settings service
// (through the test setup's message seam), `replaceStoredConfig`, `backUpCurrentConfig`,
// `assertCurrentConfigExportable`, over the extension's in-memory browser storage. The only
// stand-in is the `runMigration` hook.

import type { RawPrimary } from "./preservation-test-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backUpCurrentConfig, replaceStoredConfig } from "@/utils/backup/current-config"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { ConfigExportBlockedError, ConfigRecoveryRequiredError } from "../errors"
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
    "keeps the one exact copy startup made and replaces the pair (backupCurrent: %s), without a backup",
    async (backupCurrent) => {
      await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent })

      const all = await snapshot()
      const copies = preservedCopiesOf(all, kept)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe(reason)
      expect(backupEntries(all)).toEqual([])
      expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(false)
      expect((await getConfigStatus()).kind).toBe("usable")
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

describe("when an action reaches the service and the upgrade did not run", () => {
  // The service holds every action until startup has finished, so an older label that is still
  // there afterwards means the upgrade did not happen: it is treated as a failed one.
  beforeEach(async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
  })

  it("refuses Back up now as an unusable config, and adds no backup", async () => {
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
      reason: "migration-failed",
    })

    expect(await snapshot()).toEqual(before)
  })

  it.each([true, false])(
    "keeps an exact copy of the pair as a failed upgrade, then replaces it (backupCurrent: %s)",
    async (backupCurrent) => {
      const original = await readRawPrimary()

      await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent })

      const copies = preservedCopiesOf(await snapshot(), original)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe("migration-failed")
      expect(backupEntries(await snapshot())).toEqual([])
    },
  )

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
