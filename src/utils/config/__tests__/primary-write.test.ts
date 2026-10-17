import { beforeEach, describe, expect, it } from "vitest"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { writePrimaryMeta, writePrimaryPair } from "../primary-write"
import {
  corruptConfig,
  FIXED_MODIFIED_AT,
  readRawPrimary,
  resetStorage,
  seedPrimary,
  snapshot,
  trackPrimaryWrites,
  validConfig,
} from "./preservation-test-kit"

beforeEach(() => {
  resetStorage()
})

describe("writePrimaryPair", () => {
  it("stores the value and a complete current meta in ONE storage call", async () => {
    const tracker = trackPrimaryWrites()

    await writePrimaryPair(validConfig(), { lastModifiedAt: FIXED_MODIFIED_AT })

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config", "config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(validConfig())
    expect(stored.meta).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: FIXED_MODIFIED_AT,
    })
  })

  it("replaces the old meta instead of merging into it", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION + 5,
      lastModifiedAt: 1,
      leftover: "from an older write",
    })

    await writePrimaryPair(validConfig())

    const meta = (await readRawPrimary()).meta as Record<string, unknown>
    expect(Object.keys(meta).sort()).toEqual(["lastModifiedAt", "schemaVersion"])
    expect(meta.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("stamps the time of the write when none is given", async () => {
    const before = Date.now()

    await writePrimaryPair(validConfig())

    const meta = (await readRawPrimary()).meta as { lastModifiedAt: number }
    expect(meta.lastModifiedAt).toBeGreaterThanOrEqual(before)
  })

  it("refuses a config that does not validate, and writes nothing", async () => {
    await seedPrimary(validConfig())
    const before = await snapshot()

    await expect(writePrimaryPair(corruptConfig())).rejects.toThrow("Config is invalid")

    expect(await snapshot()).toEqual(before)
  })
})

describe("writePrimaryMeta", () => {
  it("writes only the meta, and keeps the stored value as it is", async () => {
    await seedPrimary(validConfig(), { lastModifiedAt: FIXED_MODIFIED_AT })
    const tracker = trackPrimaryWrites()

    await writePrimaryMeta({ lastModifiedAt: FIXED_MODIFIED_AT })

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(validConfig())
    expect(stored.meta).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: FIXED_MODIFIED_AT,
    })
  })
})
