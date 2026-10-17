import { beforeEach, describe, expect, it } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configSchema } from "@/types/config/config"
import { buildFreshDefaultConfig, CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { ConfigVersionTooNewError } from "../errors"
import { migrateConfig } from "../migration"
import { MAX_PRESERVED_ORIGINALS, preserveOriginal } from "../preservation"
import { KeptCopyRestoreError, restoreFromKeptCopy, startFromDefaults } from "../recovery-actions"
import { getConfigStatus, readRawConfigPair } from "../status"
import {
  backupEntries,
  corruptConfig,
  CURRENT_META,
  PREVIOUS_META,
  PREVIOUS_VERSION,
  preservedCopiesOf,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  seedBackup,
  seedPreserved,
  seedPrimary,
  snapshot,
  validConfig,
} from "./preservation-test-kit"

// The recovery actions against the real settings service (the test setup answers its messages) and
// the real preservation store, over the extension's in-memory browser storage.
const VERSION = "0.0.1"

beforeEach(() => {
  resetStorage()
})

/** Keeps `original` the way startup does, and stores it as the unusable config. */
async function unusableWithKeptCopy(
  value: unknown = corruptConfig(),
  meta: unknown = CURRENT_META,
) {
  await seedPrimary(value, meta)
  const raw = await readRawConfigPair()
  const { key } = await preserveOriginal(raw, "invalid-schema")
  return { key, original: await readRawPrimary() }
}

describe("restoreFromKeptCopy", () => {
  it("upgrades a kept copy from the version its own meta names, and replaces the unusable config", async () => {
    const { key: other } = await unusableWithKeptCopy()
    const key = await seedPreserved({ value: previousVersionConfig(), meta: PREVIOUS_META })

    await restoreFromKeptCopy(key, VERSION)

    const expected = await migrateConfig(previousVersionConfig(), PREVIOUS_VERSION)
    expect((await readRawPrimary()).value).toEqual(expected)
    expect((await getConfigStatus()).kind).toBe("usable")
    // The unusable config it replaced is still kept (exactly one copy of it), and no ordinary
    // backup of the defaults was made.
    expect((await readPreserved()).map((item) => item.key)).toContain(other)
    expect(backupEntries(await snapshot())).toEqual([])
  })

  it("backs up a usable config as stored before a kept copy replaces it", async () => {
    const stored = { ...validConfig(), contextMenu: { enabled: false } }
    await seedPrimary(stored, CURRENT_META)
    const key = await seedPreserved({ value: validConfig(), meta: CURRENT_META })

    await restoreFromKeptCopy(key, VERSION)

    expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(true)
    const backups = backupEntries(await snapshot())
    expect(backups).toHaveLength(1)
    expect((backups[0]!.backup.config as any).contextMenu.enabled).toBe(false)
  })

  it("takes a copy whose meta cannot be read as written for this version", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const key = await seedPreserved({ value: validConfig(), meta: "not-a-meta" })

    await restoreFromKeptCopy(key, VERSION)

    expect(configSchema.safeParse((await readRawPrimary()).value).success).toBe(true)
  })

  it("writes nothing and says why when the copy still fails the schema after the upgrade", async () => {
    await seedPrimary(corruptConfig("stored"), CURRENT_META)
    const key = await seedPreserved({ value: corruptConfig("kept"), meta: CURRENT_META })
    const before = await snapshot()

    await expect(restoreFromKeptCopy(key, VERSION)).rejects.toThrow(/./)

    expect(await snapshot()).toEqual(before)
  })

  it("fails with a typed error that quotes no stored value when the copy fails the schema", async () => {
    const sentinel = "sk-synthetic-sentinel-0000"
    const kept: any = validConfig()
    kept.pageTranslation.providerId = sentinel
    await seedPrimary(corruptConfig("stored"), CURRENT_META)
    const key = await seedPreserved({ value: kept, meta: CURRENT_META })

    const failure = await restoreFromKeptCopy(key, VERSION).catch((error: unknown) => error)

    expect(failure).toMatchObject({ name: "KeptCopyRestoreError", code: "invalid" })
    expect((failure as Error).message).not.toContain(sentinel)
  })

  it("writes nothing when the copy was made by a newer version", async () => {
    await seedPrimary(corruptConfig("stored"), CURRENT_META)
    const key = await seedPreserved({
      value: validConfig(),
      meta: { schemaVersion: CONFIG_SCHEMA_VERSION + 1 },
    })
    const before = await snapshot()

    await expect(restoreFromKeptCopy(key, VERSION)).rejects.toBeInstanceOf(ConfigVersionTooNewError)

    expect(await snapshot()).toEqual(before)
  })

  it("writes nothing when the copy is gone", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await snapshot()

    const failure = await restoreFromKeptCopy("configOriginal_gone", VERSION).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(KeptCopyRestoreError)
    expect(failure).toMatchObject({ code: "gone" })
    expect(await snapshot()).toEqual(before)
  })

  it("writes nothing when the copy's text cannot be read back", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    await fakeBrowser.storage.local.set({
      configOriginal_broken: {
        v: 1,
        encodedValue: "{not json",
        reason: "invalid-schema",
        capturedAt: 1,
        extensionVersion: VERSION,
      },
    })
    const before = await snapshot()

    const failure = await restoreFromKeptCopy("configOriginal_broken", VERSION).catch(
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({ name: "KeptCopyRestoreError", code: "unreadable" })
    expect(await snapshot()).toEqual(before)
  })

  it("replaces nothing when the unusable config it would replace cannot be kept first", async () => {
    // The store of copies is full of others, and the stored config is not one of them.
    for (let n = 0; n < MAX_PRESERVED_ORIGINALS - 1; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    const key = await seedPreserved({ value: validConfig(), meta: CURRENT_META })
    await seedPrimary(corruptConfig("stored"), CURRENT_META)
    const before = await snapshot()

    await expect(restoreFromKeptCopy(key, VERSION)).rejects.toMatchObject({
      name: "PreservationError",
    })

    expect(await snapshot()).toEqual(before)
  })
})

describe("startFromDefaults", () => {
  it("replaces an unusable config with the defaults and keeps one exact copy of it", async () => {
    const { original } = await unusableWithKeptCopy()

    await startFromDefaults(VERSION)

    const stored = (await readRawPrimary()).value
    expect(configSchema.safeParse(stored).success).toBe(true)
    expect((stored as any).language.targetCode).toBe(buildFreshDefaultConfig().language.targetCode)
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
    expect(backupEntries(await snapshot())).toEqual([])
  })

  it("keeps the copy first even when none was kept yet", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const original = await readRawPrimary()

    await startFromDefaults(VERSION)

    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
  })

  it("replaces nothing when the copy cannot be kept", async () => {
    for (let n = 0; n < MAX_PRESERVED_ORIGINALS; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    await seedPrimary(corruptConfig("stored"), CURRENT_META)
    const before = await snapshot()

    await expect(startFromDefaults(VERSION)).rejects.toMatchObject({ name: "PreservationError" })

    expect(await snapshot()).toEqual(before)
  })

  it("backs up a usable config before it is replaced", async () => {
    await seedPrimary({ ...validConfig(), contextMenu: { enabled: false } }, CURRENT_META)
    await seedBackup(validConfig(), 1_000)

    await startFromDefaults(VERSION)

    expect(backupEntries(await snapshot())).toHaveLength(2)
  })
})
