import { beforeEach, describe, expect, it } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  ABSENT,
  backupEntries,
  corruptConfig,
  CURRENT_META,
  failWrites,
  PREVIOUS_META,
  PREVIOUS_VERSION,
  PRESERVED_PREFIX,
  preservedCopiesOf,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  seedBackup,
  seedPrimary,
  snapshot,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { ConfigBackupBlockedError, PreservationError } from "@/utils/config/errors"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { backUpCurrentConfig, replaceStoredConfig } from "../current-config"

beforeEach(() => {
  resetStorage()
})

const OPTIONS = { backupCurrent: true, extensionVersion: "0.0.1" }

function replacement() {
  const next = validConfig()
  next.contextMenu.enabled = false
  return next
}

describe("backUpCurrentConfig", () => {
  it("adds a backup of the config exactly as stored, under the current version", async () => {
    const stored = { ...validConfig(), keyKeptAsStored: 1 }
    await seedPrimary(stored, CURRENT_META)

    await backUpCurrentConfig("0.0.1")

    const [entry] = backupEntries(await snapshot())
    expect(entry!.backup).toEqual({ schemaVersion: CONFIG_SCHEMA_VERSION, config: stored })
  })

  it("labels the backup of a config still being upgraded with its own version", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)

    await backUpCurrentConfig("0.0.1")

    expect(backupEntries(await snapshot())[0]!.backup.schemaVersion).toBe(PREVIOUS_VERSION)
  })

  it("adds a backup even when the latest one holds the same config (it is an explicit request)", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    await backUpCurrentConfig("0.0.1")
    await backUpCurrentConfig("0.0.1")

    expect(backupEntries(await snapshot())).toHaveLength(2)
  })

  it.each([
    { name: "invalid", state: () => seedPrimary(corruptConfig(), CURRENT_META) },
    { name: "of a newer version", state: () => seedPrimary(validConfig(), { schemaVersion: 999 }) },
    { name: "with a meta that cannot be read", state: () => seedPrimary(validConfig(), "x") },
    { name: "nothing", state: async () => {} },
  ])("refuses when the stored config is $name, and writes nothing", async ({ state }) => {
    await state()
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigBackupBlockedError)

    expect(await snapshot()).toEqual(before)
  })
})

describe("replaceStoredConfig", () => {
  it("writes the replacement with a complete current meta", async () => {
    await seedPrimary(validConfig(), { schemaVersion: 1, lastModifiedAt: 1, leftover: true })

    await replaceStoredConfig(replacement(), OPTIONS)

    const stored = await readRawPrimary()
    expect(stored.value).toEqual(replacement())
    expect(Object.keys(stored.meta as object).sort()).toEqual(["lastModifiedAt", "schemaVersion"])
    expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("backs up a usable config as stored first, unless asked not to", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    await replaceStoredConfig(replacement(), OPTIONS)
    expect(backupEntries(await snapshot())).toHaveLength(1)

    await seedPrimary(validConfig(), CURRENT_META)
    await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: false })
    expect(backupEntries(await snapshot())).toHaveLength(1)
  })

  it("skips the backup when the latest one already holds exactly the stored config", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await seedBackup(validConfig(), 1_000)

    await replaceStoredConfig(replacement(), OPTIONS)

    expect(backupEntries(await snapshot())).toHaveLength(1)
  })

  it("backs up a config still being upgraded with its own version", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)

    await replaceStoredConfig(replacement(), OPTIONS)

    expect(backupEntries(await snapshot())[0]!.backup.schemaVersion).toBe(PREVIOUS_VERSION)
  })

  it("keeps an exact copy of an unusable config instead of a backup, then replaces it", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const original = await readRawPrimary()

    await replaceStoredConfig(replacement(), OPTIONS)

    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
    expect(backupEntries(await snapshot())).toEqual([])
    expect((await readRawPrimary()).value).toEqual(replacement())
  })

  it("replaces nothing when the copy of an unusable config cannot be made", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await snapshot()
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_PREFIX)))

    await expect(replaceStoredConfig(replacement(), OPTIONS)).rejects.toBeInstanceOf(
      PreservationError,
    )

    expect(await snapshot()).toEqual(before)
  })

  it("replaces a profile with nothing stored, without a backup or a copy", async () => {
    await replaceStoredConfig(replacement(), OPTIONS)

    expect(backupEntries(await snapshot())).toEqual([])
    expect(await readPreserved()).toEqual([])
    expect((await readRawPrimary()).value).toEqual(replacement())
  })

  it("keeps the copy of a config with no meta distinct from one with a meta", async () => {
    await seedPrimary(corruptConfig(), ABSENT)
    const withoutMeta = await readRawPrimary()
    await replaceStoredConfig(replacement(), OPTIONS)
    await seedPrimary(corruptConfig(), CURRENT_META)
    const withMeta = await readRawPrimary()
    await replaceStoredConfig(replacement(), OPTIONS)

    const all = await snapshot()
    expect(preservedCopiesOf(all, withoutMeta)).toHaveLength(1)
    expect(preservedCopiesOf(all, withMeta)).toHaveLength(1)
    expect(
      Object.keys(await fakeBrowser.storage.local.get()).filter((key) =>
        key.startsWith(PRESERVED_PREFIX),
      ),
    ).toHaveLength(2)
  })
})
