// What the actions do AFTER a startup that could not upgrade a stored config.
//
// A stored config with an older version label is "upgrading" until startup has migrated it. When
// startup cannot (a step throws, or the migrated value still fails the schema) it leaves the pair as
// it is and keeps an exact copy; the label stays old. Every reader that runs later must see that as
// an unusable config, not as an upgrade that is merely still pending, and every action that would
// replace, back up or export the stored config must refuse, exactly as it does for any other
// config that cannot be used. The same actions are refused while the upgrade has not run at all.
//
// Real code: `initializeConfig`, the migration chain, the status reader, `replaceStoredConfig`,
// `backUpCurrentConfig`, `assertCurrentConfigExportable`, over the extension's in-memory browser
// storage. The only stand-in is the `runMigration` hook.

import type { RawPrimary } from "./preservation-test-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backUpCurrentConfig, replaceStoredConfig } from "@/utils/backup/current-config"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import {
  ConfigExportBlockedError,
  ConfigRecoveryRequiredError,
  ConfigUpgradePendingError,
} from "../errors"
import { assertCurrentConfigExportable, getConfigStatus } from "../status"
import {
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
    "refuses to replace it (backupCurrent: %s), and writes nothing",
    async (backupCurrent) => {
      const before = await snapshot()

      await expect(
        replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
      ).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

      expect(await snapshot()).toEqual(before)
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

describe("before startup has upgraded a stored config", () => {
  beforeEach(async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
  })

  it.each([true, false])(
    "refuses to replace it (backupCurrent: %s) with a retryable error, and writes nothing",
    async (backupCurrent) => {
      const before = await snapshot()

      await expect(
        replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
      ).rejects.toBeInstanceOf(ConfigUpgradePendingError)

      expect(await snapshot()).toEqual(before)
    },
  )

  it("refuses Back up now with a retryable error, and adds no backup", async () => {
    const before = await snapshot()

    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigUpgradePendingError)

    expect(await snapshot()).toEqual(before)
  })

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

    it.each([true, false])(
      "refuses to replace it (backupCurrent: %s), and writes nothing",
      async (backupCurrent) => {
        const before = await snapshot()

        await expect(
          replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent }),
        ).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)

        expect(await snapshot()).toEqual(before)
      },
    )

    it("refuses Back up now and the export of current settings, with the reason", async () => {
      await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigRecoveryRequiredError)
      await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason })
    })
  })
})

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

  it("still refuses every destructive action in that context, with the retryable error", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    failWrites(() => true)
    throwingStep()
    await startBackground()
    vi.restoreAllMocks()
    forgetWhatTheBackgroundRemembers()
    const before = await snapshot()

    await expect(
      replaceStoredConfig(replacement(), { ...OPTIONS, backupCurrent: true }),
    ).rejects.toBeInstanceOf(ConfigUpgradePendingError)
    await expect(backUpCurrentConfig("0.0.1")).rejects.toBeInstanceOf(ConfigUpgradePendingError)
    await expect(assertCurrentConfigExportable()).rejects.toMatchObject({ reason: "upgrading" })

    expect(await snapshot()).toEqual(before)
  })

  it("does not apply to a pair that is not the one that failed", async () => {
    await failedStartWithNoRoomForACopy()

    await seedPrimary(previousVersionConfig(), { ...PREVIOUS_META, lastModifiedAt: 5 })

    expect(await getConfigStatus()).toMatchObject({ kind: "upgrading" })
  })

  it("is dropped by a later start whose upgrade works, and the pair is usable again", async () => {
    await failedStartWithNoRoomForACopy()
    expect(await getConfigStatus()).toMatchObject({ kind: "suspect" })

    migration.hook = null
    await startBackground()

    expect((await getConfigStatus()).kind).toBe("usable")
    forgetWhatTheBackgroundRemembers()
    expect((await getConfigStatus()).kind).toBe("usable")
    expect(
      Object.keys(await snapshot()).filter((key) => key.startsWith("configInitFailure")),
    ).toEqual([])
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
