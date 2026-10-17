import type { RawConfigPair } from "../status"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { ConfigExportBlockedError } from "../errors"
import {
  assertCurrentConfigExportable,
  classifyConfigPair,
  getConfigStatus,
  getConfigView,
  readModifiedAt,
  readRawConfigPair,
  viewOfStatus,
  watchConfigStatus,
} from "../status"
import {
  ABSENT,
  corruptConfig,
  CURRENT_META,
  FIXED_MODIFIED_AT,
  holdFirstCall,
  previousVersionConfig,
  PREVIOUS_META,
  resetStorage,
  seedPrimary,
  settle,
  validConfig,
} from "./preservation-test-kit"

function pair(value: unknown, meta: unknown = ABSENT): RawConfigPair {
  return {
    value,
    hasValue: value !== undefined && value !== null,
    meta: meta === ABSENT ? undefined : meta,
    hasMeta: meta !== ABSENT && meta !== undefined,
  }
}

beforeEach(() => {
  resetStorage()
})

describe("readRawConfigPair", () => {
  it("reports an empty profile as having neither key", async () => {
    expect(await readRawConfigPair()).toMatchObject({ hasValue: false, hasMeta: false })
  })

  it.each([false, 0, "", [], {}])("reports a stored %j as a stored value", async (value) => {
    await seedPrimary(value, ABSENT)

    const raw = await readRawConfigPair()

    expect(raw.hasValue).toBe(true)
    expect(raw.value).toEqual(value)
    expect(raw.hasMeta).toBe(false)
  })

  it("tells a stored meta of any shape from a missing one", async () => {
    await seedPrimary(validConfig(), "not-a-meta")
    expect(await readRawConfigPair()).toMatchObject({ hasMeta: true, meta: "not-a-meta" })

    await seedPrimary(validConfig(), {})
    expect(await readRawConfigPair()).toMatchObject({ hasMeta: true, meta: {} })
  })

  it("reads both keys in one storage call", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const get = vi.spyOn(fakeBrowser.storage.local, "get")

    await readRawConfigPair()

    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]![0]).toEqual(["config", "config$"])
  })
})

describe("classifyConfigPair", () => {
  it("calls an empty pair absent, whatever the meta says", () => {
    expect(classifyConfigPair(pair(undefined)).kind).toBe("absent")
    expect(classifyConfigPair(pair(null, CURRENT_META)).kind).toBe("absent")
  })

  it("calls a valid config with the current label usable, and parses it", () => {
    const status = classifyConfigPair(pair(validConfig(), CURRENT_META))

    expect(status).toMatchObject({ kind: "usable", metaMissing: false })
  })

  it.each([
    { name: "missing", meta: ABSENT as unknown },
    { name: "an object without a version", meta: { lastModifiedAt: 1 } as unknown },
    { name: "an empty object", meta: {} as unknown },
  ])("calls a valid config usable, with the label assumed, when the meta is $name", ({ meta }) => {
    expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({
      kind: "usable",
      metaMissing: true,
    })
  })

  it("calls a config that fails the schema suspect(invalid-schema) at the current label and with no label", () => {
    expect(classifyConfigPair(pair(corruptConfig(), CURRENT_META))).toMatchObject({
      kind: "suspect",
      reason: "invalid-schema",
    })
    expect(classifyConfigPair(pair(corruptConfig(), ABSENT))).toMatchObject({
      kind: "suspect",
      reason: "invalid-schema",
    })
  })

  it.each([false, 0, "", "text", [1], 7])(
    "calls the stored value %j suspect(invalid-schema), never absent",
    (value) => {
      expect(classifyConfigPair(pair(value, CURRENT_META))).toMatchObject({
        kind: "suspect",
        reason: "invalid-schema",
      })
    },
  )

  it("calls any config with an older label upgrading, valid or not, without migrating it", () => {
    expect(classifyConfigPair(pair(previousVersionConfig(), PREVIOUS_META))).toMatchObject({
      kind: "upgrading",
      fromVersion: CONFIG_SCHEMA_VERSION - 1,
    })
    expect(classifyConfigPair(pair("text", { schemaVersion: 3 }))).toMatchObject({
      kind: "upgrading",
      fromVersion: 3,
    })
  })

  it("calls a config labelled by a newer version suspect(newer-version), valid or not", () => {
    const newer = { schemaVersion: CONFIG_SCHEMA_VERSION + 1 }
    expect(classifyConfigPair(pair(validConfig(), newer))).toMatchObject({
      kind: "suspect",
      reason: "newer-version",
    })
    expect(classifyConfigPair(pair("text", newer))).toMatchObject({
      kind: "suspect",
      reason: "newer-version",
    })
  })

  it.each([
    { name: "a string", meta: "x" as unknown },
    { name: "null", meta: null as unknown },
    { name: "an array", meta: [111] as unknown },
    { name: "a number", meta: 111 as unknown },
    { name: "a version given as text", meta: { schemaVersion: "111" } as unknown },
    { name: "a version of zero", meta: { schemaVersion: 0 } as unknown },
    { name: "a negative version", meta: { schemaVersion: -1 } as unknown },
    { name: "a fractional version", meta: { schemaVersion: 110.5 } as unknown },
    { name: "a version that is not finite", meta: { schemaVersion: Infinity } as unknown },
    { name: "a version of null", meta: { schemaVersion: null } as unknown },
  ])("calls a valid config suspect(incoherent) when its meta is $name", ({ meta }) => {
    expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({
      kind: "suspect",
      reason: "incoherent",
    })
  })

  it("keeps the raw pair on the status it returns", () => {
    const raw = pair(corruptConfig(), CURRENT_META)

    expect(classifyConfigPair(raw).raw).toBe(raw)
  })
})

describe("readModifiedAt", () => {
  it.each([
    { meta: { lastModifiedAt: 5 }, expected: 5 },
    { meta: { lastModifiedAt: "5" }, expected: undefined },
    { meta: { lastModifiedAt: Number.NaN }, expected: undefined },
    { meta: "x", expected: undefined },
    { meta: ABSENT as unknown, expected: undefined },
  ])("reads $meta as $expected", ({ meta, expected }) => {
    expect(readModifiedAt(pair(validConfig(), meta))).toBe(expected)
  })
})

describe("the session view", () => {
  it("has no config when nothing is stored", async () => {
    expect((await getConfigView()).config).toBeNull()
  })

  it("is the parsed value when usable", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    const view = await getConfigView()

    expect(view.status.kind).toBe("usable")
    expect(view.config).toEqual(validConfig())
  })

  it("is the defaults, in memory only, when the stored value is suspect", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = structuredClone(await fakeBrowser.storage.local.get())

    const view = await getConfigView()

    expect(view.config).toBe(DEFAULT_CONFIG)
    expect(await fakeBrowser.storage.local.get()).toEqual(before)
  })

  it("uses a config that is still being upgraded if it already validates, and the defaults if not", () => {
    const valid = viewOfStatus(classifyConfigPair(pair(validConfig(), PREVIOUS_META)))
    expect(valid.status.kind).toBe("upgrading")
    expect(valid.config).toEqual(validConfig())

    const invalid = viewOfStatus(classifyConfigPair(pair(previousVersionConfig(), PREVIOUS_META)))
    expect(invalid.status.kind).toBe("upgrading")
    expect(invalid.config).toBe(DEFAULT_CONFIG)
  })
})

describe("assertCurrentConfigExportable", () => {
  it("passes for an empty profile, a usable config and a config being upgraded", async () => {
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()

    await seedPrimary(validConfig(), CURRENT_META)
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()

    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()
  })

  it("is refused, naming the reason, for a suspect config", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({
      reason: "invalid-schema",
    })
  })
})

describe("watchConfigStatus", () => {
  let stop: (() => void) | undefined
  const views: Array<Awaited<ReturnType<typeof getConfigView>>> = []

  async function write(value: unknown, meta: unknown = CURRENT_META) {
    await seedPrimary(value, meta)
    await settle()
  }

  beforeEach(async () => {
    views.length = 0
    await seedPrimary(validConfig(), CURRENT_META)
    stop = watchConfigStatus((view) => views.push(view))
    await settle()
  })

  afterEach(() => {
    stop?.()
    stop = undefined
  })

  it("delivers nothing for the state at subscription time", () => {
    expect(views).toEqual([])
  })

  it("delivers the session view when the stored config changes", async () => {
    const changed = { ...validConfig(), contextMenu: { enabled: false } }

    await write(changed)

    expect(views).toHaveLength(1)
    expect(views[0]!.config).toEqual(changed)
    expect(views[0]!.status.kind).toBe("usable")
  })

  it("delivers the defaults, not the payload, when the stored config becomes unusable", async () => {
    await write(corruptConfig())

    expect(views).toHaveLength(1)
    expect(views[0]!.config).toBe(DEFAULT_CONFIG)
    expect(views[0]!.status).toMatchObject({ kind: "suspect", reason: "invalid-schema" })
  })

  it("does not deliver a change that leaves the view as it was (a meta-only write)", async () => {
    await fakeBrowser.storage.local.set({
      config$: { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: FIXED_MODIFIED_AT + 1 },
    })
    await settle()

    expect(views).toEqual([])
  })

  it("ignores changes to other keys", async () => {
    await fakeBrowser.storage.local.set({ somethingElse: 1 })
    await settle()

    expect(views).toEqual([])
  })

  it("delivers the latest read when several are in flight", async () => {
    const gate = holdFirstCall("get", (keys) => keys.includes("config"))
    const first = { ...validConfig(), contextMenu: { enabled: false } }
    const second = {
      ...validConfig(),
      floatingButton: { ...validConfig().floatingButton, locked: true },
    }

    await fakeBrowser.storage.local.set({ config: structuredClone(first) })
    await gate.reached
    await fakeBrowser.storage.local.set({ config: structuredClone(second) })
    await settle()
    gate.release()
    await settle()

    expect(views.at(-1)!.config).toEqual(second)
  })

  it("stops delivering after it is stopped", async () => {
    stop?.()
    stop = undefined

    await write({ ...validConfig(), contextMenu: { enabled: false } })

    expect(views).toEqual([])
  })

  it("reads the status again from storage, so a half-written pair is never delivered as it came", async () => {
    // A value that fails the schema arrives together with a newer label than this build knows.
    await fakeBrowser.storage.local.set({
      config: { not: "a config" },
      config$: { schemaVersion: CONFIG_SCHEMA_VERSION + 1 },
    })
    await settle()

    expect(views).toHaveLength(1)
    expect(views[0]!.status).toMatchObject({ kind: "suspect", reason: "newer-version" })
  })
})

describe("getConfigStatus", () => {
  it("is the classification of what is stored right now", async () => {
    expect((await getConfigStatus()).kind).toBe("absent")

    await seedPrimary(validConfig(), CURRENT_META)
    expect((await getConfigStatus()).kind).toBe("usable")
  })
})
