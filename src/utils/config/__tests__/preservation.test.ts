import type { RawConfigPair } from "../status"
import { isDeepStrictEqual } from "node:util"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { PreservationError } from "../errors"
import {
  decodeLossless,
  encodeLossless,
  listPreservedOriginals,
  MAX_PRESERVED_ORIGINALS,
  PRESERVED_ORIGINAL_PREFIX,
  preservedOriginalKey,
  preserveOriginal,
} from "../preservation"
import {
  ABSENT,
  corruptConfig,
  CURRENT_META,
  failWrites,
  readPreserved,
  resetStorage,
  seedPreserved,
  snapshot,
} from "./preservation-test-kit"

function rawPair(value: unknown, meta: unknown = ABSENT): RawConfigPair {
  return {
    value,
    hasValue: value !== undefined && value !== null,
    meta: meta === ABSENT ? undefined : meta,
    hasMeta: meta !== ABSENT,
  }
}

beforeEach(() => {
  resetStorage()
})

describe("the lossless encoding", () => {
  it.each([
    ["an object", { a: 1, b: [true, "x", null], c: { d: "e" } }],
    ["a string", "text"],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
    ["null", null],
    ["an empty array", []],
    ["an empty object", {}],
    ["a negative number", -12.5],
  ])("round-trips %s", (_name, value) => {
    expect(decodeLossless(encodeLossless(value))).toEqual(value)
  })

  it("round-trips what JSON cannot say", () => {
    const original = {
      missing: undefined,
      notANumber: Number.NaN,
      up: Infinity,
      down: -Infinity,
      negativeZero: -0,
      big: 12345678901234567890n,
      when: new Date("2026-10-17T00:00:00.000Z"),
      list: [undefined, 1],
    }

    const decoded = decodeLossless(encodeLossless(original)) as typeof original

    expect(Object.hasOwn(decoded, "missing")).toBe(true)
    expect(decoded.missing).toBeUndefined()
    expect(decoded.notANumber).toBeNaN()
    expect(decoded.up).toBe(Infinity)
    expect(decoded.down).toBe(-Infinity)
    expect(Object.is(decoded.negativeZero, -0)).toBe(true)
    expect(decoded.big).toBe(12345678901234567890n)
    expect(decoded.when).toEqual(original.when)
    expect(decoded.list).toEqual([undefined, 1])
  })

  it("keeps a key named like its own tag, and a key named __proto__, as ordinary keys", () => {
    const original = JSON.parse(
      '{"$t":"n","v":"NaN","__proto__":{"polluted":true},"nested":{"$t":"u"}}',
    )

    const decoded = decodeLossless(encodeLossless(original)) as Record<string, unknown>

    expect(JSON.stringify(decoded)).toBe(JSON.stringify(sortedClone(original)))
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it("writes the same text for the same data, whatever order its keys were stored in", () => {
    expect(encodeLossless({ a: 1, b: { c: 2, d: 3 } })).toBe(
      encodeLossless({ b: { d: 3, c: 2 }, a: 1 }),
    )
  })

  it("tells absent, null, false, zero and the empty string apart", () => {
    const texts = [null, false, 0, ""].map((value) => encodeLossless(value))

    expect(new Set(texts).size).toBe(4)
  })

  it.each([
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a Map", new Map()],
    ["a Set", new Set()],
    [
      "a class instance",
      new (class Thing {
        value = 1
      })(),
    ],
    ["an invalid Date", new Date("nope")],
  ])("refuses %s, nested or not", (_name, value) => {
    expect(() => encodeLossless(value)).toThrow("cannot be encoded exactly")
    expect(() => encodeLossless({ inside: [value] })).toThrow("cannot be encoded exactly")
  })
})

/** An array of `length` slots that holds `elements` at their indices and is empty everywhere else. */
function sparse(length: number, elements: Record<number, unknown> = {}) {
  const list: unknown[] = []
  list.length = length
  for (const [index, element] of Object.entries(elements)) list[Number(index)] = element
  return list
}

describe("the lossless encoding keeps the exact shape of an array", () => {
  // As many own properties as slots, so only a check of each index tells it from a full array.
  function withHoleAndExtraProperty() {
    const list = sparse(2, { 1: "b" }) as unknown[] & { note?: string }
    list.note = "kept"
    return list
  }

  function withExtraProperty() {
    const list = [1, 2] as number[] & { note?: string }
    list.note = "kept"
    return list
  }

  it.each([
    ["one empty slot", sparse(1)],
    ["an empty slot between values", sparse(3, { 0: 1, 2: 3 })],
    ["a trailing empty slot", sparse(3, { 0: 1, 1: 2 })],
    ["an array that is only a length", sparse(5)],
    ["a nested array with an empty slot", { list: [sparse(3, { 0: 1, 2: 2 })] }],
    ["a property that is not an index", withExtraProperty()],
    ["an empty slot together with a property that is not an index", withHoleAndExtraProperty()],
  ])("round-trips %s with the same slots and properties", (_name, value) => {
    const decoded = decodeLossless(encodeLossless(value))

    expect(isDeepStrictEqual(decoded, value)).toBe(true)
  })

  it("does not turn an empty slot into an own property", () => {
    const decoded = decodeLossless(encodeLossless(sparse(1))) as unknown[]

    expect(decoded).toHaveLength(1)
    expect(Object.hasOwn(decoded, 0)).toBe(false)
  })

  it("tells an empty slot from an element that is undefined", () => {
    expect(encodeLossless(sparse(1))).not.toBe(encodeLossless([undefined]))
    expect(encodeLossless(sparse(3, { 0: 1, 2: 3 }))).not.toBe(encodeLossless([1, undefined, 3]))
    expect(preservedOriginalKey(encodeLossless(sparse(1)))).not.toBe(
      preservedOriginalKey(encodeLossless([undefined])),
    )
  })

  it("keeps the text of an ordinary array as it always was, so existing copies keep their keys", () => {
    expect(encodeLossless([1, "a", null, [true]])).toBe('[1,"a",null,[true]]')
    expect(encodeLossless([undefined, 1])).toBe('[{"$t":"u"},1]')
  })

  it("keeps a copy of a stored config that holds an array with an empty slot, exactly", async () => {
    const value = { list: sparse(3, { 0: 1, 2: 3 }) }

    const { key } = await preserveOriginal(rawPair(value, CURRENT_META), "invalid-schema")

    const [entry] = (await readPreserved()).filter((item) => item.key === key)
    expect(isDeepStrictEqual(decodeLossless(entry!.entry.encodedValue), value)).toBe(true)
  })
})

describe("the key", () => {
  it("is the same for the same pair and different for a different pair", () => {
    const a = preservedOriginalKey(encodeLossless({ a: 1 }), encodeLossless({ v: 1 }))

    expect(a).toMatch(new RegExp(`^${PRESERVED_ORIGINAL_PREFIX}[0-9a-f]{64}$`))
    expect(preservedOriginalKey(encodeLossless({ a: 1 }), encodeLossless({ v: 1 }))).toBe(a)
    expect(preservedOriginalKey(encodeLossless({ a: 2 }), encodeLossless({ v: 1 }))).not.toBe(a)
  })

  it("tells a missing meta from a null, an empty and a text meta", () => {
    const value = encodeLossless({ a: 1 })
    const keys = [
      preservedOriginalKey(value, undefined),
      preservedOriginalKey(value, encodeLossless(null)),
      preservedOriginalKey(value, encodeLossless({})),
      preservedOriginalKey(value, encodeLossless("null")),
    ]

    expect(new Set(keys).size).toBe(4)
  })

  it("is the standard SHA-256 of the encoded pair, computed without crypto.subtle", async () => {
    const { createHash } = await import("node:crypto")
    const encodedValue = encodeLossless({ a: 1 })
    const encodedMeta = encodeLossless({ v: 1 })
    // Content scripts on insecure pages have no crypto.subtle; the key must not depend on it.
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(crypto) })
    try {
      const key = preservedOriginalKey(encodedValue, encodedMeta)

      expect(key).toBe(
        `${PRESERVED_ORIGINAL_PREFIX}${createHash("sha256")
          .update(JSON.stringify([encodedValue, encodedMeta]))
          .digest("hex")}`,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("is not the same for a value and for the same text taken as a meta", () => {
    const text = encodeLossless({ a: 1 })

    expect(preservedOriginalKey(text, undefined)).not.toBe(
      preservedOriginalKey(encodeLossless(null), text),
    )
  })
})

describe("preserveOriginal", () => {
  it("stores an exact copy of the value and of the meta, then confirms it", async () => {
    const value = corruptConfig()

    const outcome = await preserveOriginal(rawPair(value, CURRENT_META), "invalid-schema")

    expect(outcome.outcome).toBe("preserved")
    const kept = await listPreservedOriginals()
    expect(kept).toHaveLength(1)
    expect(kept[0]!.key).toBe(outcome.key)
    expect(decodeLossless(kept[0]!.entry.encodedValue)).toEqual(value)
    expect(decodeLossless(kept[0]!.entry.encodedMeta!)).toEqual(CURRENT_META)
    expect(kept[0]!.entry).toMatchObject({ v: 1, reason: "invalid-schema" })
    expect(typeof kept[0]!.entry.capturedAt).toBe("number")
    expect(typeof kept[0]!.entry.extensionVersion).toBe("string")
  })

  it("keeps a copy in a context that has no crypto.subtle", async () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(crypto) })
    try {
      await expect(
        preserveOriginal(rawPair(corruptConfig(), CURRENT_META), "invalid-schema"),
      ).resolves.toMatchObject({ outcome: "preserved" })
    } finally {
      vi.unstubAllGlobals()
    }

    expect(await readPreserved()).toHaveLength(1)
  })

  it("stores no meta field when no meta was stored", async () => {
    await preserveOriginal(rawPair("text"), "invalid-schema")

    const [entry] = await readPreserved()

    expect("encodedMeta" in entry!.entry).toBe(false)
  })

  it.each([false, 0, "", [], {}])("keeps the corrupted value %j", async (value) => {
    await preserveOriginal(rawPair(value, CURRENT_META), "invalid-schema")

    const [entry] = await readPreserved()

    expect(decodeLossless(entry!.entry.encodedValue)).toEqual(value)
  })

  it("keeps a null meta apart from a missing one", async () => {
    await preserveOriginal(rawPair("text"), "invalid-schema")
    await preserveOriginal(rawPair("text", null), "incoherent")

    expect(await readPreserved()).toHaveLength(2)
  })

  it("is idempotent: the same pair is not kept twice and its first capture is left alone", async () => {
    const first = await preserveOriginal(rawPair(corruptConfig(), CURRENT_META), "invalid-schema")
    const [before] = await readPreserved()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000)
    try {
      const second = await preserveOriginal(
        rawPair(corruptConfig(), CURRENT_META),
        "migration-failed",
      )
      expect(second).toEqual({ key: first.key, outcome: "already-preserved" })
    } finally {
      vi.useRealTimers()
    }

    const kept = await readPreserved()
    expect(kept).toHaveLength(1)
    expect(kept[0]!.entry).toEqual(before!.entry)
  })

  it("never overwrites an entry that holds a different payload under the same key", async () => {
    const raw = rawPair(corruptConfig(), CURRENT_META)
    const key = await seedPreserved({ value: raw.value, meta: raw.meta })
    await fakeBrowser.storage.local.set({
      [key]: {
        v: 1,
        encodedValue: '"foreign"',
        reason: "invalid-schema",
        capturedAt: 1,
        extensionVersion: "0",
      },
    })
    const before = structuredClone(await snapshot())

    await expect(preserveOriginal(raw, "invalid-schema")).rejects.toMatchObject({
      name: "PreservationError",
      code: "verify-failed",
    })

    expect(await snapshot()).toEqual(before)
  })

  it("keeps up to the limit and refuses one more, but still accepts one it already holds", async () => {
    for (let n = 0; n < MAX_PRESERVED_ORIGINALS; n++) {
      await preserveOriginal(rawPair(corruptConfig(`kept-${n}`), CURRENT_META), "invalid-schema")
    }
    const before = await snapshot()

    await expect(
      preserveOriginal(rawPair(corruptConfig("one-too-many"), CURRENT_META), "invalid-schema"),
    ).rejects.toMatchObject({ code: "full" })
    expect(await snapshot()).toEqual(before)

    await expect(
      preserveOriginal(rawPair(corruptConfig("kept-2"), CURRENT_META), "invalid-schema"),
    ).resolves.toMatchObject({ outcome: "already-preserved" })
  })

  it("does not count keys that only start like a preserved key by other means", async () => {
    await fakeBrowser.storage.local.set({
      configOriginals: 1,
      config: {},
      config$: {},
      backup_ids: [],
    })

    await expect(
      preserveOriginal(rawPair(corruptConfig(), CURRENT_META), "invalid-schema"),
    ).resolves.toMatchObject({ outcome: "preserved" })
  })

  it("refuses a value storage could not have produced, and writes nothing", async () => {
    const before = await snapshot()

    await expect(preserveOriginal(rawPair(new Map()), "invalid-schema")).rejects.toMatchObject({
      code: "unrepresentable",
    })

    expect(await snapshot()).toEqual(before)
  })

  it("reports a failed write, and leaves nothing behind", async () => {
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_ORIGINAL_PREFIX)))

    await expect(
      preserveOriginal(rawPair(corruptConfig(), CURRENT_META), "invalid-schema"),
    ).rejects.toMatchObject({ code: "write-failed" })

    expect(await readPreserved()).toEqual([])
  })

  it("does not report success when the copy cannot be read back as written", async () => {
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: any[]
    ) => Promise<Record<string, unknown>>
    let reads = 0
    vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation((async (...args: any[]) => {
      const result = await realGet(...args)
      reads++
      // The first read lists the store; the second is the read-back of the new key.
      if (reads === 2) {
        return Object.fromEntries(
          Object.entries(result).map(([key, entry]) => [
            key,
            { ...(entry as object), encodedValue: '"changed"' },
          ]),
        )
      }
      return result
    }) as any)

    await expect(
      preserveOriginal(rawPair(corruptConfig(), CURRENT_META), "invalid-schema"),
    ).rejects.toMatchObject({ code: "verify-failed" })
  })

  it("rejects with a PreservationError that names what happened", async () => {
    const error = await preserveOriginal(rawPair(new Map()), "invalid-schema").catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(PreservationError)
    expect((error as PreservationError).message).toContain("cannot be kept exactly")
  })

  it("is a programming error to preserve nothing", async () => {
    await expect(preserveOriginal(rawPair(undefined), "invalid-schema")).rejects.toThrow(
      "no stored value to preserve",
    )
  })
})

describe("listPreservedOriginals", () => {
  it("lists the kept originals, oldest first, and skips anything that is not one", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(2_000)
      await preserveOriginal(rawPair(corruptConfig("second"), CURRENT_META), "invalid-schema")
      vi.setSystemTime(1_000)
      await preserveOriginal(rawPair(corruptConfig("first"), CURRENT_META), "invalid-schema")
    } finally {
      vi.useRealTimers()
    }
    await fakeBrowser.storage.local.set({ [`${PRESERVED_ORIGINAL_PREFIX}garbage`]: "not an entry" })

    const kept = await listPreservedOriginals()

    expect(kept.map((item) => item.entry.capturedAt)).toEqual([1_000, 2_000])
  })
})

function sortedClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedClone)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedClone((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}
