// The ordinary backups and the hourly backup next to a primary config that cannot be used.
//
// The hourly backup used to read `local:config` raw and store it labelled with the CURRENT schema
// version, whatever the value was: an invalid value, or a value that still belonged to an older
// version, became a "current" backup. It skips a config that is not usable as stored and never
// mislabels what it stores. The preservation store is outside the eight-entry rotation: adding,
// removing or clearing ordinary backups never touches it, and an original never depends on a backup
// entry surviving.
//
// Real: `setUpConfigBackup` and its alarm callback, `addBackup`, `removeBackup`, `clearAllBackups`,
// `initializeConfig`, the storage helpers over the extension's in-memory browser storage. Only the
// alarm is driven by hand, and single storage calls are held to make interleavings deterministic.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { isDeepStrictEqual } from "node:util"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import { addBackup, clearAllBackups, removeBackup } from "@/utils/backup/storage"
import {
  backupEntries,
  corruptConfig,
  CURRENT_META,
  holdFirstCall,
  originalIsSafe,
  PREVIOUS_META,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedBackup,
  seedPreserved,
  seedPrimary,
  snapshot,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { MAX_BACKUPS_COUNT } from "@/utils/constants/backup"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { setUpConfigBackup } from "../config-backup"

let tick: () => Promise<void>

async function startBackground() {
  vi.resetModules()
  const { initializeConfig } = await import("@/utils/config/init")
  return initializeConfig()
}

beforeEach(() => {
  resetStorage()
  const addListener = vi.spyOn(browser.alarms.onAlarm, "addListener")
  setUpConfigBackup()
  const listener = addListener.mock.calls.at(-1)?.[0] as (alarm: { name: string }) => Promise<void>
  tick = () => listener({ name: "config-backup" })
})

describe("the hourly backup with a primary config that is not valid", () => {
  it("adds no backup of a current-version object that fails the schema", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    await tick()

    expect(backupEntries(await snapshot())).toEqual([])
  })

  it("adds no backup of a stored string", async () => {
    await seedPrimary("not a config", CURRENT_META)

    await tick()

    expect(backupEntries(await snapshot())).toEqual([])
  })

  it("never stores an invalid value under the current version, however many ticks pass", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    for (let n = 0; n < 4; n++) await tick()

    const mislabelled = backupEntries(await snapshot()).filter(
      ({ backup }) =>
        backup.schemaVersion === CONFIG_SCHEMA_VERSION &&
        !configSchema.safeParse(backup.config).success,
    )
    expect(mislabelled).toEqual([])
  })

  it("never stores a previous-version value under the current version", async () => {
    const old = previousVersionConfig()
    await seedPrimary(old, PREVIOUS_META)

    await tick()

    const mislabelled = backupEntries(await snapshot()).filter(
      ({ backup }) =>
        backup.schemaVersion === CONFIG_SCHEMA_VERSION && isDeepStrictEqual(backup.config, old),
    )
    expect(mislabelled).toEqual([])
  })

  it("leaves the primary and the preservation store alone", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await readRawPrimary()

    await tick()

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(await readPreserved()).toEqual([])
  })
})

describe("controls: the hourly backup with a valid config (a control)", () => {
  it("backs up a valid current config once under the current version, then skips the identical one", async () => {
    const config = validConfig()
    await seedPrimary(config, CURRENT_META)

    await tick()
    await tick()

    const entries = backupEntries(await snapshot())
    expect(entries).toHaveLength(1)
    expect(entries[0]!.backup.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(entries[0]!.backup.config).toEqual(config)
  })

  it("does nothing when nothing is stored", async () => {
    await tick()

    expect(backupEntries(await snapshot())).toEqual([])
  })
})

describe("controls: ordinary backup rotation leaves the preservation store alone (a control)", () => {
  async function seedFiveOriginals() {
    const originals: RawPrimary[] = []
    for (let n = 0; n < 5; n++) {
      const original: RawPrimary = { value: corruptConfig(`kept-${n}`), meta: CURRENT_META }
      originals.push(original)
      await seedPreserved(original)
    }
    return originals
  }

  it("keeps all five entries through twelve backups, which rotate as before", async () => {
    await seedFiveOriginals()
    const before = (await readPreserved()).map(({ key, entry }) => [key, structuredClone(entry)])

    for (let n = 0; n < MAX_BACKUPS_COUNT + 4; n++) {
      await addBackup({ ...validConfig(), contextMenu: { enabled: n % 2 === 0 } }, "0.0.1")
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    expect(backupEntries(await snapshot())).toHaveLength(MAX_BACKUPS_COUNT)
    expect((await readPreserved()).map(({ key, entry }) => [key, entry])).toEqual(before)
  })

  it("keeps all five entries through removing every backup and then clearing them", async () => {
    await seedFiveOriginals()
    const before = await readPreserved()
    for (let n = 0; n < 3; n++) await seedBackup(validConfig(), 1_000 + n)

    for (const { id } of backupEntries(await snapshot())) await removeBackup(id)
    await seedBackup(validConfig(), 9_000)
    await clearAllBackups()

    expect(backupEntries(await snapshot())).toEqual([])
    expect(await readPreserved()).toEqual(before)
  })
})

describe("an original and the backup rotation at the same time", () => {
  /** Eight ordinary backups, the oldest of which is the original (as an old hourly backup left it). */
  async function seedEightBackupsOldestIsTheOriginal(original: RawPrimary) {
    await seedBackup(original.value, 1_000)
    for (let n = 1; n < MAX_BACKUPS_COUNT; n++) await seedBackup(validConfig(), 1_000 + n)
  }

  it("keeps the original when 'Backup now' rotates the oldest entry out while startup runs", async () => {
    const original: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }
    await seedPrimary(original.value, original.meta)
    await seedEightBackupsOldestIsTheOriginal(original)
    const rotation = holdFirstCall("remove", (keys) =>
      keys.some((key) => key.startsWith("configBackup_")),
    )

    const backupNow = addBackup(validConfig(), "0.0.1")
    await Promise.race([rotation.reached, new Promise((resolve) => setTimeout(resolve, 20))])
    await startBackground().catch(() => undefined)
    rotation.release()
    await backupNow

    expect(await originalIsSafe(original)).toBe(true)
    expect(sameRaw(await readRawPrimary(), original)).toBe(true)
  })

  it("keeps the original when the oldest entry is rotated out before startup runs", async () => {
    const original: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }
    await seedPrimary(original.value, original.meta)
    await seedEightBackupsOldestIsTheOriginal(original)

    await addBackup(validConfig(), "0.0.1")
    await startBackground().catch(() => undefined)

    expect(await originalIsSafe(original)).toBe(true)
  })

  it("keeps the original when the hourly backup writes its entry while startup runs", async () => {
    const original: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }
    await seedPrimary(original.value, original.meta)
    const hourly = holdFirstCall("set", (keys) =>
      keys.some((key) => key.startsWith("configBackup_")),
    )

    const hourlyTick = tick()
    await Promise.race([hourly.reached, new Promise((resolve) => setTimeout(resolve, 20))])
    await startBackground().catch(() => undefined)
    hourly.release()
    await hourlyTick

    expect(await originalIsSafe(original)).toBe(true)
    const invalidAsCurrent = backupEntries(await snapshot()).filter(
      ({ backup }) =>
        backup.schemaVersion === CONFIG_SCHEMA_VERSION &&
        !configSchema.safeParse(backup.config).success,
    )
    expect(invalidAsCurrent).toEqual([])
  })

  it("keeps a valid config valid when the hourly backup and an edit overlap (a control)", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    vi.resetModules()
    const { createStore } = await import("jotai")
    const { writeConfigAtom } = await import("@/utils/atoms/config")
    const store = createStore()
    const hourly = holdFirstCall("set", (keys) =>
      keys.some((key) => key.startsWith("configBackup_")),
    )

    const hourlyTick = tick()
    await Promise.race([hourly.reached, new Promise((resolve) => setTimeout(resolve, 20))])
    await store.set(writeConfigAtom, { contextMenu: { enabled: false } })
    hourly.release()
    await hourlyTick

    const stored = await readRawPrimary()
    expect(configSchema.safeParse(stored.value).success).toBe(true)
    expect((stored.value as any).contextMenu.enabled).toBe(false)
    for (const { backup } of backupEntries(await snapshot())) {
      expect(configSchema.safeParse(backup.config).success).toBe(true)
    }
  })
})

// Limit of this harness, stated so the results are read correctly: the fake browser storage does not
// keep `null`, so "meta stored as null" (which a real browser keeps) cannot be staged here.
