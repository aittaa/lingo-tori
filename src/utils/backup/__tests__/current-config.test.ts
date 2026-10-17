import { beforeEach, describe, expect, it } from "vitest"
import {
  ABSENT,
  backupEntries,
  corruptConfig,
  CURRENT_META,
  PREVIOUS_META,
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
import { ConfigRecoveryRequiredError } from "@/utils/config/errors"
import { digestOfStoredValue } from "@/utils/config/status"
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
    {
      name: "still labelled with an older version once startup has run",
      state: () => seedPrimary(previousVersionConfig(), PREVIOUS_META),
    },
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
  it("writes the replacement with a complete current meta, and nothing left over from the old one", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: 1,
      leftover: true,
    })

    await replaceStoredConfig(replacement(), OPTIONS)

    const stored = await readRawPrimary()
    expect(stored.value).toEqual(replacement())
    expect(Object.keys(stored.meta as object).sort()).toEqual([
      "lastModifiedAt",
      "lastOpDigest",
      "lastOpId",
      "revision",
      "schemaVersion",
      "valueDigest",
    ])
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      revision: 1,
      valueDigest: digestOfStoredValue(stored.value),
    })
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

  it("keeps a config still labelled with an older version as an exact copy, then replaces it", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const original = await readRawPrimary()

    await replaceStoredConfig(replacement(), OPTIONS)

    const copies = preservedCopiesOf(await snapshot(), original)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("migration-failed")
    expect(backupEntries(await snapshot())).toEqual([])
    expect((await readRawPrimary()).value).toEqual(replacement())
  })

  describe.each([true, false])("with backupCurrent: %s", (backupCurrent) => {
    it.each([
      {
        name: "invalid",
        state: () => seedPrimary(corruptConfig(), CURRENT_META),
        reason: "invalid-schema",
      },
      {
        name: "invalid with no meta",
        state: () => seedPrimary(corruptConfig(), ABSENT),
        reason: "invalid-schema",
      },
      {
        name: "a corrupted falsy value",
        state: () => seedPrimary(0, CURRENT_META),
        reason: "invalid-schema",
      },
      {
        name: "of a newer version",
        state: () => seedPrimary(validConfig(), { schemaVersion: 999 }),
        reason: "newer-version",
      },
      {
        name: "with a meta that cannot be read",
        state: () => seedPrimary(validConfig(), "x"),
        reason: "incoherent",
      },
    ])(
      "keeps an exact copy of a stored config that is $name, instead of a backup, and then replaces it",
      async ({ state, reason }) => {
        await state()
        const original = await readRawPrimary()

        await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent })

        const all = await snapshot()
        const copies = preservedCopiesOf(all, original)
        expect(copies).toHaveLength(1)
        expect(copies[0]!.entry.reason).toBe(reason)
        expect(backupEntries(all)).toEqual([])
        expect((await readRawPrimary()).value).toEqual(replacement())
      },
    )
  })

  it("replaces a profile with nothing stored, without a backup or a copy", async () => {
    await replaceStoredConfig(replacement(), OPTIONS)

    expect(backupEntries(await snapshot())).toEqual([])
    expect(await readPreserved()).toEqual([])
    expect((await readRawPrimary()).value).toEqual(replacement())
  })
})
