import type { RawConfigPair } from "../status"
import type { RawPrimary } from "./preservation-test-kit"
import { isDeepStrictEqual } from "node:util"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { decodeLossless, MAX_PRESERVED_ORIGINALS, preserveOriginal } from "../preservation"
import {
  buildKeptCopyExport,
  buildStoredAsFoundExport,
  listKeptCopies,
  parseRecoveryExport,
  RECOVERY_EXPORT_FORMAT,
} from "../recovery-export"
import { readRawConfigPair } from "../status"
import {
  ABSENT,
  corruptConfig,
  CURRENT_META,
  failWrites,
  PREVIOUS_META,
  previousVersionConfig,
  resetStorage,
  seedBackup,
  seedPreserved,
  seedPrimary,
  snapshot,
  validConfig,
} from "./preservation-test-kit"

const SECRET = "sk-synthetic-sentinel-0000"

function sparse(length: number, elements: Record<number, unknown>) {
  const list: unknown[] = []
  list.length = length
  for (const [index, element] of Object.entries(elements)) list[Number(index)] = element
  return list
}

/** A config that fails the schema, holds a synthetic key, and has values JSON cannot say. */
function exoticOriginal(): RawPrimary {
  const value: any = corruptConfig()
  value.providersConfig.find((provider: any) => "apiKey" in provider).apiKey = SECRET
  value.exotic = {
    notANumber: Number.NaN,
    missing: undefined,
    slots: sparse(3, { 0: "a", 2: "c" }),
    when: new Date("2026-10-17T00:00:00.000Z"),
  }
  return { value, meta: CURRENT_META }
}

/**
 * The fake storage keeps JSON, so a value that holds NaN, a Date, `undefined` or an empty slot cannot
 * be stored in it. The tests that need such a value hand it to the code directly: as a raw pair for
 * the kept copy, and as what `storage.local.get` returns for the stored pair.
 */
function rawPairOf(original: RawPrimary): RawConfigPair {
  return { value: original.value, hasValue: true, meta: original.meta, hasMeta: true }
}

function storageHolds(original: RawPrimary) {
  vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation(
    (): Promise<Record<string, unknown>> =>
      Promise.resolve({ config: original.value, config$: original.meta }),
  )
}

beforeEach(() => {
  resetStorage()
})

describe("listKeptCopies", () => {
  it("lists what was kept, oldest first, with no stored value in it", async () => {
    const original = exoticOriginal()
    await seedPrimary(original.value, original.meta)
    const raw = await readRawConfigPair()
    await seedPreserved({ value: corruptConfig("older"), meta: CURRENT_META })
    await preserveOriginal(raw, "invalid-schema")

    const copies = await listKeptCopies()

    expect(copies).toHaveLength(2)
    expect(copies[0]!.capturedAt).toBeLessThan(copies[1]!.capturedAt)
    expect(copies.map((copy) => copy.reason)).toEqual(["invalid-schema", "invalid-schema"])
    const text = JSON.stringify(copies)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("encodedValue")
    expect(Object.keys(copies[0]!).sort()).toEqual([
      "capturedAt",
      "extensionVersion",
      "key",
      "reason",
    ])
  })

  it("is empty when nothing was kept", async () => {
    await seedBackup(validConfig(), 1_000)

    expect(await listKeptCopies()).toEqual([])
  })
})

describe("buildKeptCopyExport", () => {
  it("holds the value and meta exactly, whatever JSON could not say", async () => {
    const original = exoticOriginal()
    const { key } = await preserveOriginal(rawPairOf(original), "invalid-schema")

    const download = await buildKeptCopyExport(key)

    const file = parseRecoveryExport(download.json)
    expect(file).toMatchObject({
      format: RECOVERY_EXPORT_FORMAT,
      source: "kept-copy",
      reason: "invalid-schema",
    })
    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), original.value)).toBe(true)
    expect(isDeepStrictEqual(decodeLossless(file.encodedMeta!), original.meta)).toBe(true)
    // The shapes the fake storage cannot hold are really in this value.
    expect(Number.isNaN((decodeLossless(file.encodedValue) as any).exotic.notANumber)).toBe(true)
    expect(Object.hasOwn((decodeLossless(file.encodedValue) as any).exotic.slots, 1)).toBe(false)
  })

  it("is the entry's own text, so the file is the copy and not a re-encoding of something else", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const { key } = await preserveOriginal(await readRawConfigPair(), "invalid-schema")
    const [entry] = Object.entries(await snapshot())
      .filter(([name]) => name === key)
      .map(
        ([, value]) => value as { encodedValue: string; encodedMeta: string; capturedAt: number },
      )

    const file = parseRecoveryExport((await buildKeptCopyExport(key)).json)

    expect(file.encodedValue).toBe(entry!.encodedValue)
    expect(file.encodedMeta).toBe(entry!.encodedMeta)
    expect(file.capturedAt).toBe(entry!.capturedAt)
  })

  it("leaves out the meta when the original had none", async () => {
    await seedPrimary(corruptConfig(), ABSENT)
    const { key } = await preserveOriginal(await readRawConfigPair(), "invalid-schema")

    const file = parseRecoveryExport((await buildKeptCopyExport(key)).json)

    expect(file.encodedMeta).toBeUndefined()
    expect(Object.hasOwn(file, "encodedMeta")).toBe(false)
  })

  it("keeps the credentials in the file, as stored: the file is a copy, not a share", async () => {
    const original = exoticOriginal()
    await seedPrimary(original.value, original.meta)
    const { key } = await preserveOriginal(await readRawConfigPair(), "invalid-schema")

    const download = await buildKeptCopyExport(key)

    expect(download.json).toContain(SECRET)
  })

  it("names the file for what it is, without the stored data in the name", async () => {
    const original = exoticOriginal()
    await seedPrimary(original.value, original.meta)
    const { key } = await preserveOriginal(await readRawConfigPair(), "invalid-schema")

    const { fileName } = await buildKeptCopyExport(key)

    expect(fileName).toMatch(/^[\w-]+-unreadable-settings-[\w-]+\.json$/)
    expect(fileName).not.toContain(SECRET)
  })

  it.each([
    { name: "a key nothing is kept under", key: "configOriginal_0000" },
    { name: "the config itself", key: "config" },
    { name: "the config's meta", key: "config$" },
    { name: "a backup", key: "configBackup_1_x" },
  ])("refuses $name, and exports nothing", async ({ key }) => {
    await seedPrimary(validConfig(), CURRENT_META)
    await seedBackup(validConfig(), 1_000)

    await expect(buildKeptCopyExport(key)).rejects.toThrow("no longer exists")
  })

  it("changes nothing in storage", async () => {
    const original = exoticOriginal()
    await seedPrimary(original.value, original.meta)
    const { key } = await preserveOriginal(await readRawConfigPair(), "invalid-schema")
    const before = await snapshot()

    await buildKeptCopyExport(key)

    expect(await snapshot()).toEqual(before)
  })
})

describe("buildStoredAsFoundExport", () => {
  it("holds the stored value and meta exactly, whatever JSON could not say, kept copy or not", async () => {
    const original = exoticOriginal()
    storageHolds(original)

    const file = parseRecoveryExport((await buildStoredAsFoundExport()).json)

    expect(file).toMatchObject({ source: "stored-as-found" })
    expect(file.reason).toBeUndefined()
    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), original.value)).toBe(true)
    expect(isDeepStrictEqual(decodeLossless(file.encodedMeta!), original.meta)).toBe(true)
  })

  it("works when the store of kept copies is full", async () => {
    for (let n = 0; n < MAX_PRESERVED_ORIGINALS; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    const original = exoticOriginal()
    await seedPrimary(original.value, original.meta)
    const raw = await readRawConfigPair()
    await expect(preserveOriginal(raw, "invalid-schema")).rejects.toMatchObject({ code: "full" })

    const file = parseRecoveryExport((await buildStoredAsFoundExport()).json)

    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), raw.value)).toBe(true)
  })

  it("works when storage refuses every write", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    failWrites(() => true)

    const file = parseRecoveryExport((await buildStoredAsFoundExport()).json)

    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), corruptConfig())).toBe(true)
  })

  it.each([
    {
      name: "a config still labelled with an older version",
      value: previousVersionConfig(),
      meta: PREVIOUS_META,
    },
    { name: "a corrupted falsy value", value: 0, meta: ABSENT as unknown },
    { name: "a meta that is not an object", value: validConfig(), meta: "x" as unknown },
  ])("exports $name as it is", async ({ value, meta }) => {
    await seedPrimary(value, meta)
    const raw = await readRawConfigPair()

    const file = parseRecoveryExport((await buildStoredAsFoundExport()).json)

    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), raw.value)).toBe(true)
    expect(file.encodedMeta === undefined).toBe(!raw.hasMeta)
  })

  it("refuses when nothing is stored", async () => {
    await expect(buildStoredAsFoundExport()).rejects.toThrow("no stored settings")
  })

  it("changes nothing in storage", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await snapshot()

    await buildStoredAsFoundExport()

    expect(await snapshot()).toEqual(before)
  })
})

describe("parseRecoveryExport", () => {
  it.each([
    "null",
    "[]",
    '{"format":"something-else"}',
    '{"format":"lingotori-config-recovery","formatVersion":2}',
  ])("rejects %s", (text) => {
    expect(() => parseRecoveryExport(text)).toThrow("Not a recovery export")
  })
})
