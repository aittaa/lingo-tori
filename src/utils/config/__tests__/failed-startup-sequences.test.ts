// What the actions do AFTER a startup that could not upgrade a stored config.
//
// A stored config with an older version label is "upgrading" until startup has migrated it. When
// startup cannot (a step throws, or the migrated value still fails the schema) it leaves the pair as
// it is and keeps an exact copy; the label stays old. Every reader that runs later must see that as
// an unusable config, not as an upgrade that is merely still pending. Restoring, importing or
// resetting is then the user's explicit way out: it keeps the exact copy (the one startup made, not
// a second one) and replaces the pair, while Back up now and exporting the current settings refuse,
// as they do for any other config that cannot be used.
//
// Real code: `initializeConfig`, the migration chain, the status reader, the settings service
// (through the test setup's message seam), `replaceStoredConfig`, `backUpCurrentConfig`,
// `assertCurrentConfigExportable`, over the extension's in-memory browser storage. The only
// stand-in is the `runMigration` hook.

import type { RawPrimary } from "./preservation-test-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backUpCurrentConfig, replaceStoredConfig } from "@/utils/backup/current-config"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { ConfigExportBlockedError, ConfigRecoveryRequiredError } from "../errors"
import { assertCurrentConfigExportable, getConfigStatus } from "../status"
import {
  backgroundRemembersAFailure,
  backupEntries,
  corruptConfig,
  CURRENT_META,
  failWrites,
  forgetWhatTheBackgroundRemembers,
  MAX_PRESERVED,
  preservedCopiesOf,
  PREVIOUS_META,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPreserved,
  seedPrimary,
  snapshot,
  touchesPrimary,
  validConfig,
} from "./preservation-test-kit"

const migration = vi.hoisted(() => ({
  hook: null as
    | null
    | ((
        version: number,
        config: any,
        real: (version: number, config: any) => Promise<any>,
      ) => Promise<any>),
}))

vi.mock("../migration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../migration")>()
  return {
    ...actual,
    runMigration: (version: number, config: any) =>
      migration.hook
        ? migration.hook(version, config, actual.runMigration)
        : actual.runMigration(version, config),
  }
})

async function startBackground() {
  vi.resetModules()
  const { initializeConfig } = await import("../init")
  return initializeConfig()
}

beforeEach(() => {
  resetStorage()
  migration.hook = null
})

afterEach(() => {
  migration.hook = null
})

const OPTIONS = { extensionVersion: "0.0.1" }

function replacement() {
  const next = validConfig()
  next.contextMenu.enabled = false
  return next
}

const FAILURES = [
  {
    name: "a migration step throws",
    reason: "migration-failed",
    prepare: () => {
      migration.hook = async (version, config, real) => {
        if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
        return real(version, config)
      }
    },
    original: (): RawPrimary => ({ value: previousVersionConfig(), meta: PREVIOUS_META }),
  },
  {
    name: "the upgraded value still fails the schema (the real upgrade runs)",
    reason: "invalid-schema",
    prepare: () => {},
    original: (): RawPrimary => ({
      value: { ...previousVersionConfig(), contextMenu: { enabled: "yes" } },
      meta: PREVIOUS_META,
    }),
  },
] as const

describe.each(FAILURES)("after a startup where $name", ({ reason, prepare, original }) => {
  let kept: RawPrimary

  beforeEach(async () => {
    kept = original()
    await seedPrimary(kept.value, kept.meta)
    prepare()
    await startBackground()
  })

  it("leaves the pair as it was, with one exact copy of it", async () => {
    expect(sameRaw(await readRawPrimary(), kept)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), kept)).toHaveLength(1)
  })

  it("reads the stored config as unusable for the reason startup recorded, not as an upgrade", async () => {
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason })
  })

  it.each([true, false])(
    "keeps the one exact copy startup made and replaces the pair (backupCurrent: %s), without a backup",
    async (backupCurrent) => {
      await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent })

      const all = await snapshot()
      const copies = preservedCopiesOf(all, kept)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe(reason)
      expect(backupEntries(all)).toEqual([])
      expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(false)
      expect((await getConfigStatus()).kind).toBe("usable")
    },
  )

  it("refuses Back up now, and adds no backup", async () => {
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

    expect(await snapshot()).toEqual(before)
    expect(backupEntries(await snapshot())).toEqual([])
  })

  it("refuses to export it as the current settings", async () => {
    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason })
  })
})

describe("when an action reaches the service and the upgrade did not run", () => {
  // The service holds every action until startup has finished, so an older label that is still
  // there afterwards means the upgrade did not happen: it is treated as a failed one.
  beforeEach(async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
  })

  it("refuses Back up now as an unusable config, and adds no backup", async () => {
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
      reason: "migration-failed",
    })

    expect(await snapshot()).toEqual(before)
  })

  it.each([true, false])(
    "keeps an exact copy of the pair as a failed upgrade, then replaces it (backupCurrent: %s)",
    async (backupCurrent) => {
      const original = await readRawPrimary()

      await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent })

      const copies = preservedCopiesOf(await snapshot(), original)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe("migration-failed")
      expect(backupEntries(await snapshot())).toEqual([])
    },
  )

  it("refuses to export it as the current settings", async () => {
    await expect(assertCurrentConfigExportable()).rejects.toBeInstanceOf(ConfigExportBlockedError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason: "upgrading" })
  })
})

describe("controls: a startup that does upgrade the stored config", () => {
  beforeEach(async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    await startBackground()
  })

  it("leaves a usable config, and the actions are allowed again", async () => {
    expect((await getConfigStatus()).kind).toBe("usable")
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()

    await backUpCurrentConfig("0.0.1")
    await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: true })

    expect(backupEntries(await snapshot()).length).toBeGreaterThan(0)
    expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(false)
  })
})

describe("a later start, once the step works", () => {
  it("upgrades the config that an earlier start could not, and the actions are allowed", async () => {
    const original: RawPrimary = { value: previousVersionConfig(), meta: PREVIOUS_META }
    await seedPrimary(original.value, original.meta)
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }
    await startBackground()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })

    migration.hook = null
    await startBackground()

    expect((await getConfigStatus()).kind).toBe("usable")
    // The earlier copy stays: nothing deletes a kept original on its own.
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
    await expect(assertCurrentConfigExportable()).resolves.toBeUndefined()
  })
})

// A completed failed upgrade is a failed upgrade whether or not a copy of the pair could be kept:
// the store of copies can be full and storage can refuse the write (the same conditions the
// "as found" export exists for). The outcome is remembered for the exact pair, in storage when a
// small marker can be written and in the background's memory always.
describe.each([
  {
    name: "the store of kept copies is full",
    prepare: async () => {
      for (let n = 0; n < MAX_PRESERVED; n++) {
        await seedPreserved({ value: corruptConfig(`other-${n}`), meta: PREVIOUS_META })
      }
    },
    beforeStart: () => {},
  },
  {
    name: "every write fails",
    prepare: async () => {},
    beforeStart: () => failWrites(() => true),
  },
] as const)("after a startup that could not keep a copy because $name", (scenario) => {
  describe.each(FAILURES)("and $name", ({ reason, prepare, original }) => {
    let stored: RawPrimary

    beforeEach(async () => {
      await scenario.prepare()
      stored = original()
      await seedPrimary(stored.value, stored.meta)
      prepare()
      scenario.beforeStart()
      await startBackground()
      vi.restoreAllMocks()
    })

    it("has really kept no copy of the pair (the scenario)", async () => {
      expect(preservedCopiesOf(await snapshot(), stored)).toHaveLength(0)
    })

    it("leaves the pair as it was", async () => {
      expect(sameRaw(await readRawPrimary(), stored)).toBe(true)
    })

    it("reads the stored config as unusable for the reason startup found, not as a retryable upgrade", async () => {
      expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason })
    })

    it("refuses Back up now and the export of current settings, with the reason", async () => {
      await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)
      await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason })
    })
  })
})

// What a request to replace such a pair does once the user asks: the same as for any unusable
// config. A copy is kept first, and nothing is replaced when it cannot be.
describe.each(FAILURES)(
  "a replacement after a startup that could not keep a copy, where $name",
  ({ reason, prepare, original }) => {
    async function failedStart(how: "full-store" | "failing-writes") {
      const stored = original()
      if (how === "full-store") {
        for (let n = 0; n < MAX_PRESERVED; n++) {
          await seedPreserved({ value: corruptConfig(`other-${n}`), meta: PREVIOUS_META })
        }
      }
      await seedPrimary(stored.value, stored.meta)
      prepare()
      if (how === "failing-writes") failWrites(() => true)
      await startBackground()
      vi.restoreAllMocks()
      return stored
    }

    it.each([true, false])(
      "replaces nothing while the store of kept copies is still full (backupCurrent: %s)",
      async (backupCurrent) => {
        const stored = await failedStart("full-store")
        const before = await snapshot()

        await expect(
          replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
        ).rejects.toMatchObject({ name: "PreservationError", code: "full" })

        expect(await snapshot()).toEqual(before)
        expect(sameRaw(await readRawPrimary(), stored)).toBe(true)
      },
    )

    it.each([true, false])(
      "keeps an exact copy first and then replaces it once storage works (backupCurrent: %s)",
      async (backupCurrent) => {
        const stored = await failedStart("failing-writes")

        await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent })

        const copies = preservedCopiesOf(await snapshot(), stored)
        expect(copies).toHaveLength(1)
        expect(copies[0]!.entry.reason).toBe(reason)
        expect((await getConfigStatus()).kind).toBe("usable")
      },
    )
  },
)

describe("the outcome of a failed upgrade, and when it stops applying", () => {
  const throwingStep = () => {
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }
  }

  async function failedStartWithNoRoomForACopy() {
    for (let n = 0; n < MAX_PRESERVED; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: PREVIOUS_META })
    }
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    throwingStep()
    await startBackground()
  }

  it("is kept in storage when a marker can be written, so another context sees it too", async () => {
    await failedStartWithNoRoomForACopy()
    // A context that never ran the startup: nothing in memory, only what is stored.
    forgetWhatTheBackgroundRemembers()

    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })
  })

  it("is not kept anywhere but the background's memory when even the marker cannot be written", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    failWrites(() => true)
    throwingStep()
    await startBackground()
    vi.restoreAllMocks()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })

    // The honest limit: a context that cannot see the background's memory still says "upgrading".
    forgetWhatTheBackgroundRemembers()
    expect(await getConfigStatus()).toMatchObject({ kind: "upgrading" })
  })

  it("is taken for a failed upgrade by the service in that context too: Back up now and export refuse, a replacement keeps a copy first", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const original = await readRawPrimary()
    failWrites(() => true)
    throwingStep()
    await startBackground()
    vi.restoreAllMocks()
    forgetWhatTheBackgroundRemembers()

    // The reader of this context reads "upgrading"; the service has seen startup finish and takes an
    // older label that is still there for a failed upgrade.
    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason: "upgrading" })
    await replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: true })

    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
    expect((await getConfigStatus()).kind).toBe("usable")
  })

  it("does not apply to a pair that is not the one that failed", async () => {
    await failedStartWithNoRoomForACopy()

    await seedPrimary(previousVersionConfig(), { ...PREVIOUS_META, lastModifiedAt: 5 })

    expect(await getConfigStatus()).toMatchObject({ kind: "upgrading" })
  })

  it("is dropped by a later start whose upgrade works, and the pair is usable again", async () => {
    await failedStartWithNoRoomForACopy()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect" })

    expect(backgroundRemembersAFailure()).toBe(true)

    migration.hook = null
    await startBackground()

    expect((await getConfigStatus()).kind).toBe("usable")
    forgetWhatTheBackgroundRemembers()
    expect((await getConfigStatus()).kind).toBe("usable")
    expect(
      Object.keys(await snapshot()).filter((key) => key.startsWith("configInitFailure")),
    ).toEqual([])
    expect(backgroundRemembersAFailure()).toBe(false)
  })

  // The record goes only when the upgraded pair is stored. A retry whose upgrade works but whose
  // write is refused leaves the very pair that failed, so it is still a failed upgrade to everyone.
  it.each([
    { name: "the write of the pair is rejected", fails: touchesPrimary },
    { name: "every write is rejected", fails: () => true },
  ])("is kept when a later start upgrades the pair but $name", async ({ fails }) => {
    await failedStartWithNoRoomForACopy()
    const before = await readRawPrimary()
    migration.hook = null
    failWrites(fails)

    await expect(startBackground()).rejects.toThrow("simulated write failure")
    vi.restoreAllMocks()

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), before)).toHaveLength(0)
    expect(backgroundRemembersAFailure()).toBe(true)
    expect(Object.keys(await snapshot())).toContain("configInitFailure")
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })

    forgetWhatTheBackgroundRemembers()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })

    const stored = await snapshot()
    await expect(
      replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: true }),
    ).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)
    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({
      reason: "migration-failed",
    })
    expect(await snapshot()).toEqual(stored)
  })

  it("is dropped by the retry once its write has gone through, after a rejected one", async () => {
    await failedStartWithNoRoomForACopy()
    migration.hook = null
    failWrites(touchesPrimary, 1)
    await expect(startBackground()).rejects.toThrow("simulated write failure")
    vi.restoreAllMocks()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "migration-failed" })

    await startBackground()

    expect((await getConfigStatus()).kind).toBe("usable")
    expect(Object.keys(await snapshot())).not.toContain("configInitFailure")
    expect(backgroundRemembersAFailure()).toBe(false)
  })

  it("is dropped by a start that finds the stored config unusable for another reason", async () => {
    await failedStartWithNoRoomForACopy()
    expect(Object.keys(await snapshot())).toContain("configInitFailure")

    await seedPrimary(corruptConfig(), CURRENT_META)
    migration.hook = null
    await startBackground()

    expect(Object.keys(await snapshot())).not.toContain("configInitFailure")
    forgetWhatTheBackgroundRemembers()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "invalid-schema" })
  })

  it("is not written, nor removed, by a start that has nothing to record or forget", async () => {
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    await seedPrimary(validConfig(), CURRENT_META)
    const writes = vi.spyOn(fakeBrowser.storage.local, "set")
    const removals = vi.spyOn(fakeBrowser.storage.local, "remove")

    await startBackground()

    expect(removals).not.toHaveBeenCalled()
    expect(writes.mock.calls.map(([items]) => Object.keys(items))).not.toContainEqual(
      expect.arrayContaining(["configInitFailure"]),
    )
  })

  it("is replaced by the outcome of the latest start, whatever it was", async () => {
    await failedStartWithNoRoomForACopy()
    // The same pair now fails for another reason: the step works but its result is invalid.
    migration.hook = async (version, config, real) => {
      const migrated = await real(version, config)
      return { ...migrated, contextMenu: { enabled: "yes" } }
    }
    await startBackground()

    expect(await getConfigStatus()).toMatchObject({ kind: "suspect", reason: "invalid-schema" })
  })

  it("is announced to a watcher that is already showing the stored config", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const { watchConfigStatus } = await import("../status")
    const views: Array<{ status: { kind: string } }> = []
    const stop = watchConfigStatus((view) => views.push(view))
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let n = 0; n < MAX_PRESERVED; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: PREVIOUS_META })
    }
    throwingStep()
    views.length = 0

    await startBackground()
    // The watcher reads again after each notification; wait for the read that follows the record.
    await vi.waitFor(() =>
      expect(views.at(-1)?.status).toMatchObject({ kind: "suspect", reason: "migration-failed" }),
    )
    stop()

    expect((await readPreserved()).length).toBe(MAX_PRESERVED)
  })
})
