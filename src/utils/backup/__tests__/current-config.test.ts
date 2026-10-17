import { beforeEach, describe, expect, it } from "vitest"
import {
  ABSENT,
  backupEntries,
  corruptConfig,
  CURRENT_META,
  PREVIOUS_META,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  seedBackup,
  seedPrimary,
  snapshot,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { ConfigRecoveryRequiredError, ConfigUpgradePendingError } from "@/utils/config/errors"
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

  it("refuses while the stored config has not been upgraded yet, and writes nothing", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigUpgradePendingError)

    expect(await snapshot()).toEqual(before)
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
  ])("refuses when the stored config is $name, and writes nothing", async ({ state }) => {
    await state()
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

    expect(await snapshot()).toEqual(before)
  })

  it("says there is nothing to back up when nothing is stored", async () => {
    await expect(backUpCurrentConfig("0.0.1")).rejects.toThrow("no saved settings")

    expect(await snapshot()).toEqual({})
  })
})

describe("replaceStoredConfig", () => {
  it("writes the replacement with a complete current meta", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 1,
      leftover: true,
    })

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

  it.each([true, false])(
    "refuses while the stored config has not been upgraded yet (backupCurrent: %s), and writes nothing",
    async (backupCurrent) => {
      await seedPrimary(previousVersionConfig(), PREVIOUS_META)
      const before = await snapshot()

      await expect(
        replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
      ).rejects.toBeInstanceOf(ConfigUpgradePendingError)

      expect(await snapshot()).toEqual(before)
    },
  )

  it.each([
    { name: "invalid", state: () => seedPrimary(corruptConfig(), CURRENT_META) },
    { name: "invalid with no meta", state: () => seedPrimary(corruptConfig(), ABSENT) },
    { name: "a corrupted falsy value", state: () => seedPrimary(0, CURRENT_META) },
    { name: "of a newer version", state: () => seedPrimary(validConfig(), { schemaVersion: 999 }) },
    { name: "with a meta that cannot be read", state: () => seedPrimary(validConfig(), "x") },
  ])(
    "refuses to replace a stored config that is $name: nothing is written, not even a backup",
    async ({ state }) => {
      await state()
      const before = await snapshot()

      await expect(replaceStoredConfig(replacement(), OPTIONS)).rejects.toBeInstanceOf(
        ConfigRecoveryRequiredError,
      )
      await expect(
        replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: false }),
      ).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

      expect(await snapshot()).toEqual(before)
    },
  )

  it("replaces a profile with nothing stored, without a backup or a copy", async () => {
    await replaceStoredConfig(replacement(), OPTIONS)

    expect(backupEntries(await snapshot())).toEqual([])
    expect(await readPreserved()).toEqual([])
    expect((await readRawPrimary()).value).toEqual(replacement())
  })
})
