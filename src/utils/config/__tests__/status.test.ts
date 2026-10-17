import type { RawConfigPair } from "../status"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  ConfigExportBlockedError,
  ConfigRecoveryRequiredError,
  ConfigUpgradePendingError,
} from "../errors"
import { preserveOriginal } from "../preservation"
import {
  assertConfigWritable,
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
  holdFirstResult,
  previousVersionConfig,
  PREVIOUS_META,
  PREVIOUS_VERSION,
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

  const BAD_TIMES = [
    { name: "text", value: "not-a-timestamp" as unknown },
    { name: "a number given as text", value: "1700000000000" as unknown },
    { name: "null", value: null as unknown },
    { name: "a boolean", value: true as unknown },
    { name: "an object", value: {} as unknown },
    { name: "an array", value: [] as unknown },
    { name: "not a number", value: Number.NaN as unknown },
    { name: "infinite", value: Infinity as unknown },
    { name: "negative infinity", value: -Infinity as unknown },
  ]

  it.each(BAD_TIMES)(
    "calls a valid config suspect(incoherent) when its modified time is $name, whatever the version label",
    ({ value }) => {
      const metas = [
        { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: value },
        { lastModifiedAt: value },
        { schemaVersion: PREVIOUS_VERSION, lastModifiedAt: value },
      ]
      for (const meta of metas) {
        expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({
          kind: "suspect",
          reason: "incoherent",
        })
      }
    },
  )

  // The project's fake storage keeps JSON, so a property that is `undefined` never reaches the code
  // through it; these pairs are built by hand, as a browser that keeps such a property would hand
  // them over.
  it.each([
    { name: "the current label", meta: { schemaVersion: CONFIG_SCHEMA_VERSION } },
    { name: "an older label", meta: { schemaVersion: PREVIOUS_VERSION } },
    { name: "no label", meta: {} },
  ])(
    "calls a valid config suspect(incoherent) when its meta has its own lastModifiedAt set to undefined, with $name",
    ({ meta }) => {
      const withUndefinedTime = { ...meta, lastModifiedAt: undefined }
      expect(Object.hasOwn(withUndefinedTime, "lastModifiedAt")).toBe(true)

      expect(classifyConfigPair(pair(validConfig(), withUndefinedTime))).toMatchObject({
        kind: "suspect",
        reason: "incoherent",
      })
    },
  )

  it("still lets a recognised newer version win over an own undefined time", () => {
    const meta = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, lastModifiedAt: undefined }

    expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({
      kind: "suspect",
      reason: "newer-version",
    })
  })

  it("keeps a meta that has no lastModifiedAt property at all as a missing time, not a malformed one", () => {
    const meta = { schemaVersion: CONFIG_SCHEMA_VERSION }
    expect(Object.hasOwn(meta, "lastModifiedAt")).toBe(false)

    expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({ kind: "usable" })
  })

  it("lets a recognised newer version label win over a malformed modified time", () => {
    const meta = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, lastModifiedAt: "not-a-timestamp" }

    expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({
      kind: "suspect",
      reason: "newer-version",
    })
  })

  it("lets a malformed version label win over a malformed modified time (both are unreadable)", () => {
    const meta = { schemaVersion: "111", lastModifiedAt: "not-a-timestamp" }

    expect(classifyConfigPair(pair(validConfig(), meta))).toMatchObject({
      kind: "suspect",
      reason: "incoherent",
    })
  })

  it.each([0, -5, 1.5, FIXED_MODIFIED_AT])(
    "accepts %s as a modified time: only a value that is not a finite number is malformed",
    (value) => {
      expect(
        classifyConfigPair(
          pair(validConfig(), { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: value }),
        ),
      ).toMatchObject({ kind: "usable", metaMissing: false })
    },
  )

  it("still treats a missing modified time as an older writer's meta, not as a malformed one", () => {
    expect(
      classifyConfigPair(pair(validConfig(), { schemaVersion: CONFIG_SCHEMA_VERSION })),
    ).toMatchObject({ kind: "usable" })
    expect(
      classifyConfigPair(pair(previousVersionConfig(), { schemaVersion: PREVIOUS_VERSION })),
    ).toMatchObject({ kind: "upgrading" })
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
  it("passes for an empty profile and a usable config", async () => {
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()

    await seedPrimary(validConfig(), CURRENT_META)
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()
  })

  it("is refused, naming the reason, for a suspect config", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({
      reason: "invalid-schema",
    })
  })

  it("is refused while the stored config is still labelled with an older version", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)

    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason: "upgrading" })
  })

  it("points to a recovery option that exists", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    await expect(assertCurrentConfigExportable()).rejects.toThrow(/recovery export/i)
  })
})

describe("assertConfigWritable", () => {
  it("allows a profile with nothing stored and a usable config", async () => {
    await expect(assertConfigWritable()).resolves.toBeUndefined()

    await seedPrimary(validConfig(), CURRENT_META)
    await expect(assertConfigWritable()).resolves.toBeUndefined()

    await seedPrimary(validConfig(), ABSENT)
    await expect(assertConfigWritable()).resolves.toBeUndefined()
  })

  it.each([
    {
      name: "invalid",
      value: corruptConfig(),
      meta: CURRENT_META as unknown,
      reason: "invalid-schema",
    },
    {
      name: "a corrupted falsy value",
      value: 0,
      meta: CURRENT_META as unknown,
      reason: "invalid-schema",
    },
    {
      name: "of a newer version",
      value: validConfig(),
      meta: { schemaVersion: CONFIG_SCHEMA_VERSION + 1 } as unknown,
      reason: "newer-version",
    },
    {
      name: "with a meta that cannot be read",
      value: validConfig(),
      meta: "x" as unknown,
      reason: "incoherent",
    },
  ])("refuses, naming why, when the stored config is $name", async ({ value, meta, reason }) => {
    await seedPrimary(value, meta)

    await expect(assertConfigWritable()).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)
    await expect(assertConfigWritable()).rejects.toMatchObject({ reason })
  })

  it("refuses with a retryable error while the stored config is still being upgraded", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)

    await expect(assertConfigWritable()).rejects.toBeInstanceOf(ConfigUpgradePendingError)
  })

  it("refuses when the stored config cannot be read at all (it fails closed)", async () => {
    vi.spyOn(fakeBrowser.storage.local, "get").mockRejectedValue(new Error("storage unavailable"))

    await expect(assertConfigWritable()).rejects.toThrow("storage unavailable")
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

  it("delivers the latest read, and drops an older read that answers late", async () => {
    const gate = holdFirstResult((keys) => keys.includes("config"))
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

    expect(views.map((view) => view.config)).toEqual([second])
  })

  it("stops delivering after it is stopped", async () => {
    stop?.()
    stop = undefined

    await write({ ...validConfig(), contextMenu: { enabled: false } })

    expect(views).toEqual([])
  })

  it("reads the pair again from storage and delivers the validated view, not the notification's payload", async () => {
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

describe("getConfigStatus for a config a startup could not upgrade", () => {
  async function seedUpgrading() {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    return readRawConfigPair()
  }

  it.each(["migration-failed", "invalid-schema"] as const)(
    "is suspect(%s) for the pair a kept copy holds, not a retryable upgrade",
    async (reason) => {
      await preserveOriginal(await seedUpgrading(), reason)

      expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason })
    },
  )

  it("is still upgrading when no kept copy holds this pair", async () => {
    const raw = await seedUpgrading()

    expect(await getConfigStatus()).toMatchObject({
      kind: "upgrading",
      fromVersion: PREVIOUS_VERSION,
    })
    expect(raw.hasValue).toBe(true)
  })

  it("is still upgrading when the kept copies hold other pairs only", async () => {
    await preserveOriginal(pair(corruptConfig(), CURRENT_META), "invalid-schema")
    await seedUpgrading()

    expect(await getConfigStatus()).toMatchObject({ kind: "upgrading" })
  })

  it("is upgrading again once the pair is no longer the one a copy holds", async () => {
    await preserveOriginal(await seedUpgrading(), "migration-failed")
    await seedPrimary(previousVersionConfig(), { ...PREVIOUS_META, lastModifiedAt: 5 })

    expect(await getConfigStatus()).toMatchObject({ kind: "upgrading" })
  })

  it("leaves a usable pair usable even when a copy of the same pair is kept", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await preserveOriginal(await readRawConfigPair(), "invalid-schema")

    expect(await getConfigStatus()).toMatchObject({ kind: "usable" })
  })

  it("gives the session the defaults, because a pair that could not be upgraded is not used", async () => {
    await preserveOriginal(await seedUpgrading(), "migration-failed")

    const view = await getConfigView()

    expect(view.config).toBe(DEFAULT_CONFIG)
    expect(view.status.kind).toBe("suspect")
  })

  it("is delivered to a watcher when the copy appears", async () => {
    const raw = await seedUpgrading()
    const views: Array<Awaited<ReturnType<typeof getConfigView>>> = []
    const stop = watchConfigStatus((view) => views.push(view))
    await settle()

    await preserveOriginal(raw, "migration-failed")
    await settle()
    stop()

    expect(views).toHaveLength(1)
    expect(views[0]!.status).toMatchObject({ kind: "suspect", reason: "migration-failed" })
  })
})
