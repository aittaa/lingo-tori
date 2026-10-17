import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { commitPrimary, commitPrimaryMeta, CommitVerificationError } from "../primary-write"
import { classifyConfigPair, digestOfStoredValue, readRawConfigPair } from "../status"
import {
  corruptConfig,
  CURRENT_META,
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

async function contextFor(opId = "op-1") {
  return { previous: await readRawConfigPair(), opId, opDigest: `digest-of-${opId}` }
}

describe("commitPrimary", () => {
  it("stores the value and a complete current meta in ONE storage call", async () => {
    const tracker = trackPrimaryWrites()

    await commitPrimary(validConfig(), {
      ...(await contextFor()),
      lastModifiedAt: FIXED_MODIFIED_AT,
    })

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config", "config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(validConfig())
    expect(stored.meta).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: FIXED_MODIFIED_AT,
      revision: 1,
      lastOpId: "op-1",
      lastOpDigest: "digest-of-op-1",
      valueDigest: digestOfStoredValue(validConfig()),
    })
  })

  it("counts the revision up from the previous one, and from 0 for a meta without one", async () => {
    await seedPrimary(validConfig(), { ...CURRENT_META, revision: 6 })
    expect((await commitPrimary(validConfig(), await contextFor())).revision).toBe(7)

    await seedPrimary(validConfig(), CURRENT_META)
    expect((await commitPrimary(validConfig(), await contextFor("op-2"))).revision).toBe(1)
  })

  it("replaces the old meta instead of merging into it", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION + 5,
      lastModifiedAt: 1,
      leftover: "from an older write",
    })

    await commitPrimary(validConfig(), await contextFor())

    const meta = (await readRawPrimary()).meta as Record<string, unknown>
    expect(Object.keys(meta).sort()).toEqual([
      "lastModifiedAt",
      "lastOpDigest",
      "lastOpId",
      "revision",
      "schemaVersion",
      "valueDigest",
    ])
    expect(meta.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("leaves a pair that classifies as usable, with the receipt of this operation", async () => {
    await commitPrimary(validConfig(), await contextFor("op-9"))

    expect(classifyConfigPair(await readRawConfigPair())).toMatchObject({
      kind: "usable",
      lastOpId: "op-9",
      lastOpDigest: "digest-of-op-9",
      revision: 1,
    })
  })

  it("returns the receipt that a later request can be compared with", async () => {
    const receipt = await commitPrimary(validConfig(), await contextFor())

    expect(receipt).toEqual({ revision: 1, valueHash: digestOfStoredValue(validConfig()) })
  })

  it("refuses a config that does not validate, and writes nothing", async () => {
    await seedPrimary(validConfig())
    const before = await snapshot()

    await expect(commitPrimary(corruptConfig(), await contextFor())).rejects.toThrow(
      "Config is invalid",
    )

    expect(await snapshot()).toEqual(before)
  })

  it("does not report success when the pair does not read back as written", async () => {
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: any[]
    ) => Promise<Record<string, unknown>>
    let reads = 0
    vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation((async (...args: any[]) => {
      const result = await realGet(...args)
      reads++
      // The first read is the context's; the second is the read-back after the write.
      return reads === 2
        ? { ...result, config: { ...(result.config as object), edited: true } }
        : result
    }) as any)
    const context = await contextFor()

    await expect(commitPrimary(validConfig(), context)).rejects.toBeInstanceOf(
      CommitVerificationError,
    )
  })

  it("does not report success when the meta did not make it", async () => {
    const realSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local)
    vi.spyOn(fakeBrowser.storage.local, "set").mockImplementation(
      (items: Record<string, unknown>) => realSet({ config: items.config }),
    )

    await expect(commitPrimary(validConfig(), await contextFor())).rejects.toBeInstanceOf(
      CommitVerificationError,
    )
  })
})

describe("commitPrimaryMeta", () => {
  it("writes only the meta, adds the digest of the stored value, and keeps the value as it is", async () => {
    await seedPrimary(validConfig(), { lastModifiedAt: FIXED_MODIFIED_AT })
    const tracker = trackPrimaryWrites()

    await commitPrimaryMeta({
      ...(await contextFor("bootstrap")),
      lastModifiedAt: FIXED_MODIFIED_AT,
    })

    expect(tracker.writes).toEqual([{ method: "set", keys: ["config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(validConfig())
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: FIXED_MODIFIED_AT,
      revision: 1,
      valueDigest: digestOfStoredValue(validConfig()),
    })
  })
})
