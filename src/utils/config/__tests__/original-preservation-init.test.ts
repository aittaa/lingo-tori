// What startup (`initializeConfig`) does to a stored config it cannot use.
//
// The rule under test: a stored `local:config` (and its meta) that startup cannot validate or migrate
// is an ORIGINAL. Startup keeps it where it is, keeps an exact copy in the preservation store, and
// the session runs on the defaults in memory. It never writes the defaults over it.
//
// Real code: `initializeConfig`, the migration chain, `configSchema`, over the extension's in-memory
// browser storage. The only stand-in is the `runMigration` hook, so that a step can be made to fail
// or to leave a visible mark.

import type { RawPrimary } from "./preservation-test-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configSchema } from "@/types/config/config"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import {
  ABSENT,
  corruptConfig,
  crashAtWrite,
  CURRENT_META,
  failWrites,
  FIXED_MODIFIED_AT,
  MAX_PRESERVED,
  originalIsSafe,
  PREVIOUS_META,
  PREVIOUS_VERSION,
  preservedCopiesOf,
  PRESERVED_PREFIX,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPreserved,
  seedPrimary,
  snapshot,
  trackPrimaryWrites,
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

/** A fresh module graph each time, as a service-worker start gets one. */
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

/** The fixtures keep the context menu on; the marking step switches it off. */
function isMarked(config: any) {
  return config?.contextMenu?.enabled === false
}

/** A migration step that leaves a visible mark, and refuses to run on a config that carries it. */
function markingStep() {
  return async (version: number, config: any, real: (v: number, c: any) => Promise<any>) => {
    if (version !== CONFIG_SCHEMA_VERSION) return real(version, config)
    if (isMarked(config)) throw new Error(`step ${version} was applied twice`)
    const migrated = await real(version, config)
    return { ...migrated, contextMenu: { ...migrated.contextMenu, enabled: false } }
  }
}

interface SuspectCase {
  name: string
  original: () => RawPrimary
  /** Why the stored pair is not used. */
  reason: "invalid-schema" | "incoherent"
}

const SUSPECT_CASES: SuspectCase[] = [
  {
    name: "a current-version object with one wrong-typed field",
    original: () => ({ value: corruptConfig(), meta: CURRENT_META }),
    reason: "invalid-schema",
  },
  {
    name: "the same, with no meta stored",
    original: () => ({ value: corruptConfig(), meta: ABSENT }),
    reason: "invalid-schema",
  },
  {
    name: "the same, with a meta that is not an object",
    original: () => ({ value: corruptConfig(), meta: "not-a-meta" }),
    reason: "incoherent",
  },
  {
    name: "a previous-version object that is still invalid after the upgrade",
    original: () => ({
      value: { ...previousVersionConfig(), contextMenu: { enabled: "yes" } },
      meta: PREVIOUS_META,
    }),
    reason: "invalid-schema",
  },
  {
    name: "a string",
    original: () => ({ value: "not a config", meta: CURRENT_META }),
    reason: "invalid-schema",
  },
  {
    name: "an array",
    original: () => ({ value: [1, 2, 3], meta: CURRENT_META }),
    reason: "invalid-schema",
  },
  // Falsy values were written by somebody; they are originals, not absence.
  {
    name: "the corrupted falsy value false",
    original: () => ({ value: false, meta: ABSENT }),
    reason: "invalid-schema",
  },
  {
    name: "the corrupted falsy value 0",
    original: () => ({ value: 0, meta: CURRENT_META }),
    reason: "invalid-schema",
  },
  {
    name: 'the corrupted falsy value ""',
    original: () => ({ value: "", meta: ABSENT }),
    reason: "invalid-schema",
  },
  {
    name: "a valid current config whose meta is not an object",
    original: () => ({ value: validConfig(), meta: "not-a-meta" }),
    reason: "incoherent",
  },
]

describe("startup over a primary config it cannot use", () => {
  describe.each(SUSPECT_CASES)("$name", ({ original, reason }) => {
    beforeEach(async () => {
      const raw = original()
      await seedPrimary(raw.value, raw.meta)
    })

    it("leaves local:config and its meta exactly as stored", async () => {
      const before = await readRawPrimary()
      expect(before.value).not.toBe(ABSENT)

      await startBackground()

      expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    })

    it("writes nothing to local:config or its meta, not even a temporary value", async () => {
      const tracker = trackPrimaryWrites()

      await startBackground()

      expect(tracker.writes).toEqual([])
    })

    it("keeps an exact copy of the value and its meta in the preservation store", async () => {
      const before = await readRawPrimary()

      await startBackground()

      const copies = preservedCopiesOf(await snapshot(), before)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe(reason)
      expect(copies[0]!.key.startsWith(PRESERVED_PREFIX)).toBe(true)
    })

    it("reports a stored config that is not a fresh install", async () => {
      expect(await startBackground()).toEqual({ isFreshInstall: false, hadStoredConfig: true })
    })

    it("does not change what the next start sees: repeated starts keep one copy, same key", async () => {
      const before = await readRawPrimary()

      await startBackground()
      const first = await readPreserved()
      await startBackground()
      await startBackground()
      const third = await readPreserved()

      expect(sameRaw(await readRawPrimary(), before)).toBe(true)
      expect(third.map((item) => item.key)).toEqual(first.map((item) => item.key))
      expect(preservedCopiesOf(await snapshot(), before)).toHaveLength(1)
    })
  })

  it("hands the session a usable config (a control)", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    vi.resetModules()
    const { ensureInitializedConfig } = await import("@/entrypoints/background/config")

    const sessionConfig = await ensureInitializedConfig()

    expect(configSchema.safeParse(sessionConfig).success).toBe(true)
  })

  it("hands the session its defaults without storing them", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await readRawPrimary()
    vi.resetModules()
    const { ensureInitializedConfig } = await import("@/entrypoints/background/config")

    await ensureInitializedConfig()

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  it("retries the copy on a later start when the first copy could not be written", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await readRawPrimary()
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_PREFIX)))

    await startBackground().catch(() => undefined)
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(await readPreserved()).toEqual([])

    vi.restoreAllMocks()
    await startBackground()

    expect(preservedCopiesOf(await snapshot(), before)).toHaveLength(1)
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  it("does not write over the primary when the copy cannot be written at all", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const before = await readRawPrimary()
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_PREFIX)))

    await startBackground().catch(() => undefined)

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  it("does not write, and does not add a sixth entry, when the store is full of other originals", async () => {
    await seedPrimary(corruptConfig("current"), CURRENT_META)
    const before = await readRawPrimary()
    for (let n = 0; n < MAX_PRESERVED; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }

    await startBackground().catch(() => undefined)

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(await readPreserved()).toHaveLength(MAX_PRESERVED)
  })

  it("starts from the original being present: a copy that is already there is reused, not doubled", async () => {
    const raw: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }
    await seedPrimary(raw.value, raw.meta)
    await seedPreserved(raw)

    await startBackground()

    expect(await readPreserved()).toHaveLength(1)
    expect(sameRaw(await readRawPrimary(), raw)).toBe(true)
  })

  it("keeps two different originals as two entries when they are seen by two starts", async () => {
    const first: RawPrimary = { value: corruptConfig("first"), meta: CURRENT_META }
    const second: RawPrimary = { value: corruptConfig("second"), meta: CURRENT_META }

    await seedPrimary(first.value, first.meta)
    await startBackground()
    await seedPrimary(second.value, second.meta)
    await startBackground()

    const all = await snapshot()
    expect(preservedCopiesOf(all, first)).toHaveLength(1)
    expect(preservedCopiesOf(all, second)).toHaveLength(1)
    expect(sameRaw(await readRawPrimary(), second)).toBe(true)
  })

  it("keeps the original safe whichever write a crash interrupts", async () => {
    const raw: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }

    for (let crashAt = 1; crashAt <= 6; crashAt++) {
      resetStorage()
      await seedPrimary(raw.value, raw.meta)
      crashAtWrite(crashAt)

      await startBackground().catch(() => undefined)
      vi.restoreAllMocks()

      expect(await originalIsSafe(raw), `the original after a crash at write ${crashAt}`).toBe(true)
    }
  })
})

describe("startup when a migration step throws", () => {
  const previous = () => previousVersionConfig()

  it("does not advance the stored version past the step that failed", async () => {
    await seedPrimary(previous(), PREVIOUS_META)
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }

    await startBackground()

    expect((await readRawPrimary()).meta).toEqual(PREVIOUS_META)
  })

  it("leaves the config untouched and keeps an exact copy, reason migration-failed", async () => {
    await seedPrimary(previous(), PREVIOUS_META)
    const before = await readRawPrimary()
    const tracker = trackPrimaryWrites()
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }

    const result = await startBackground()

    expect(tracker.writes).toEqual([])
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    const copies = preservedCopiesOf(await snapshot(), before)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("migration-failed")
    expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
  })

  it("stops the chain at the failing step instead of running the steps after it", async () => {
    await seedPrimary({ ...previous() }, { schemaVersion: PREVIOUS_VERSION - 1, lastModifiedAt: 1 })
    const calls: number[] = []
    migration.hook = async (version, config, real) => {
      calls.push(version)
      if (version === PREVIOUS_VERSION) throw new Error("step failed")
      return real(version, config)
    }

    await startBackground()

    expect(calls).toEqual([PREVIOUS_VERSION])
  })

  it("migrates on the next start once the step works, and only then moves the version", async () => {
    await seedPrimary(previous(), PREVIOUS_META)
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }
    await startBackground()

    migration.hook = markingStep()
    await startBackground()

    const stored = await readRawPrimary()
    expect(isMarked(stored.value)).toBe(true)
    expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("retries the copy on a later start when the first copy could not be written", async () => {
    await seedPrimary(previous(), PREVIOUS_META)
    const before = await readRawPrimary()
    migration.hook = async (version, config, real) => {
      if (version === CONFIG_SCHEMA_VERSION) throw new Error("step failed")
      return real(version, config)
    }
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_PREFIX)))
    await startBackground().catch(() => undefined)
    vi.restoreAllMocks()

    await startBackground()

    expect(preservedCopiesOf(await snapshot(), before)).toHaveLength(1)
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })
})

describe("controls: what startup does for a config it can use", () => {
  it("leaves a valid current config exactly as stored and keeps no copy", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const before = await readRawPrimary()
    const tracker = trackPrimaryWrites()

    const result = await startBackground()

    expect(tracker.writes).toEqual([])
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(await readPreserved()).toEqual([])
    expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
  })

  it("creates the defaults for a profile that has nothing stored", async () => {
    const result = await startBackground()

    const stored = await readRawPrimary()
    expect(configSchema.safeParse(stored.value).success).toBe(true)
    expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(result).toEqual({ isFreshInstall: true, hadStoredConfig: false })
    expect(await readPreserved()).toEqual([])
  })

  it("applies a successful migration: new value, new version, the old modified time kept, no copy", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    migration.hook = markingStep()

    const result = await startBackground()

    const stored = await readRawPrimary()
    expect(isMarked(stored.value)).toBe(true)
    expect(configSchema.safeParse(stored.value).success).toBe(true)
    expect(stored.meta).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModifiedAt: FIXED_MODIFIED_AT,
    })
    expect(await readPreserved()).toEqual([])
    expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
  })
})

describe("startup over a config written by a newer version", () => {
  it("leaves it alone, and keeps one copy of it", async () => {
    const newerMeta = {
      schemaVersion: CONFIG_SCHEMA_VERSION + 1,
      lastModifiedAt: FIXED_MODIFIED_AT,
    }
    await seedPrimary({ ...validConfig(), keyFromANewerVersion: { setting: "kept" } }, newerMeta)
    const before = await readRawPrimary()
    const tracker = trackPrimaryWrites()

    const result = await startBackground()

    expect(tracker.writes).toEqual([])
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    const copies = preservedCopiesOf(await snapshot(), before)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("newer-version")
    expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
  })
})

describe("guards: an interrupted write does not turn a good config into a failure", () => {
  // Value and meta used to be written by separate storage calls. If the process dies between them,
  // the next start would see a value that is ALREADY migrated under the OLD version label, run the
  // step again, and (now that a throwing step stops the chain) report a migration failure for a
  // config that is fine. Startup writes the value and the complete meta in ONE call, so the tests
  // below crash at every write and check that the next start still ends well. The marking step
  // refuses a config it has already marked, as most real steps would.
  it("a crash anywhere in a successful migration does not turn into a failure on the next start", async () => {
    for (let crashAt = 1; crashAt <= 3; crashAt++) {
      resetStorage()
      await seedPrimary(previousVersionConfig(), PREVIOUS_META)
      migration.hook = markingStep()
      crashAtWrite(crashAt)
      await startBackground().catch(() => undefined)
      vi.restoreAllMocks()

      migration.hook = markingStep()
      await startBackground()

      const stored = await readRawPrimary()
      expect(configSchema.safeParse(stored.value).success, `valid after crash ${crashAt}`).toBe(
        true,
      )
      expect((stored.meta as any).schemaVersion, `label after crash ${crashAt}`).toBe(
        CONFIG_SCHEMA_VERSION,
      )
      expect(isMarked(stored.value), `marked exactly once after crash ${crashAt}`).toBe(true)
      expect(await readPreserved(), `no copy needed after crash ${crashAt}`).toEqual([])
    }
  })

  it("a crash between the first config write and its meta leaves a config the next start accepts", async () => {
    migration.hook = null
    for (let crashAt = 1; crashAt <= 2; crashAt++) {
      resetStorage()
      crashAtWrite(crashAt)
      await startBackground().catch(() => undefined)
      vi.restoreAllMocks()

      await startBackground()

      const stored = await readRawPrimary()
      expect(configSchema.safeParse(stored.value).success, `valid after crash ${crashAt}`).toBe(
        true,
      )
      expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
      expect(await readPreserved()).toEqual([])
    }
  })
})

// `initializeConfig` used to read a missing or unusable meta as version 1 and push a current-shaped
// config through every migration step, which replaced the user's settings with defaults. A meta that
// is missing carries no label (it is assumed to be current when the value validates); a meta that is
// present but cannot be read is kept, with the value, as an original.
describe("startup over a valid current config whose meta is missing or unusable", () => {
  it.each([
    { name: "missing", meta: ABSENT as unknown },
    { name: "an empty object", meta: {} as unknown },
    { name: "an object without a version", meta: { lastModifiedAt: FIXED_MODIFIED_AT } as unknown },
  ])(
    "keeps the user's settings and commits a current meta when the meta is $name",
    async ({ meta }) => {
      const config = validConfig()
      await seedPrimary(config, meta)

      const result = await startBackground()

      const stored = await readRawPrimary()
      expect(stored.value).toEqual(config)
      expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
      expect(typeof (stored.meta as any).lastModifiedAt).toBe("number")
      expect(await readPreserved()).toEqual([])
      expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
    },
  )

  it("keeps the last modified time a meta without a version already had", async () => {
    await seedPrimary(validConfig(), { lastModifiedAt: FIXED_MODIFIED_AT })

    await startBackground()

    expect(((await readRawPrimary()).meta as any).lastModifiedAt).toBe(FIXED_MODIFIED_AT)
  })

  it.each([
    { name: "a string", meta: "not-a-meta" as unknown },
    { name: "an array", meta: [111] as unknown },
    { name: "a version that is not a whole number", meta: { schemaVersion: "111" } as unknown },
    { name: "a version of zero", meta: { schemaVersion: 0 } as unknown },
  ])(
    "keeps the pair, malformed meta included, and writes nothing when the meta is $name",
    async ({ meta }) => {
      const config = validConfig()
      await seedPrimary(config, meta)
      const before = await readRawPrimary()
      const tracker = trackPrimaryWrites()

      const result = await startBackground()

      expect(tracker.writes).toEqual([])
      expect(sameRaw(await readRawPrimary(), before)).toBe(true)
      const copies = preservedCopiesOf(await snapshot(), before)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe("incoherent")
      expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
    },
  )
})

describe("startup over a valid config whose meta holds a malformed modified time", () => {
  const BAD = [
    { name: "text", value: "not-a-timestamp" as unknown },
    { name: "a number given as text", value: "1700000000000" as unknown },
    { name: "null", value: null as unknown },
    { name: "a boolean", value: true as unknown },
    { name: "an object", value: { at: 1 } as unknown },
    { name: "an array", value: [1] as unknown },
  ]

  it.each(BAD)(
    "keeps the pair, malformed time included, and writes nothing when the time is $name",
    async ({ value }) => {
      const config = validConfig()
      await seedPrimary(config, { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: value })
      const before = await readRawPrimary()
      const tracker = trackPrimaryWrites()

      const result = await startBackground()

      expect(tracker.writes).toEqual([])
      expect(sameRaw(await readRawPrimary(), before)).toBe(true)
      const copies = preservedCopiesOf(await snapshot(), before)
      expect(copies).toHaveLength(1)
      expect(copies[0]!.entry.reason).toBe("incoherent")
      expect(result).toEqual({ isFreshInstall: false, hadStoredConfig: true })
    },
  )

  it("does the same when the meta has no version label but a malformed time", async () => {
    await seedPrimary(validConfig(), { lastModifiedAt: "not-a-timestamp" })
    const before = await readRawPrimary()

    await startBackground()

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), before)).toHaveLength(1)
  })

  it("does the same for a config with an older label, without running the upgrade", async () => {
    const spy = vi.fn<(version: number) => void>()
    migration.hook = async (version, config, real) => {
      spy(version)
      return real(version, config)
    }
    await seedPrimary(previousVersionConfig(), {
      ...PREVIOUS_META,
      lastModifiedAt: "not-a-timestamp",
    })
    const before = await readRawPrimary()

    await startBackground()

    expect(spy).not.toHaveBeenCalled()
    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), before)).toHaveLength(1)
  })

  it("keeps a recognised newer version as newer-version, whatever the time says", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION + 1,
      lastModifiedAt: "not-a-timestamp",
    })
    const before = await readRawPrimary()

    await startBackground()

    const copies = preservedCopiesOf(await snapshot(), before)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("newer-version")
  })

  it("still gives a meta with no modified time at all the current meta (a control)", async () => {
    await seedPrimary(validConfig(), { schemaVersion: CONFIG_SCHEMA_VERSION })

    await startBackground()

    const stored = await readRawPrimary()
    expect(typeof (stored.meta as any).lastModifiedAt).toBe("number")
    expect(await readPreserved()).toEqual([])
  })
})

describe("startup when the migration cannot give a usable config", () => {
  it("keeps the ORIGINAL, not a partly migrated value, when a step changes the config and then throws", async () => {
    const original: RawPrimary = { value: previousVersionConfig(), meta: PREVIOUS_META }
    await seedPrimary(original.value, original.meta)
    migration.hook = async (_version, config) => {
      // A step that edits the object it was given before it fails.
      config.contextMenu.enabled = false
      config.partlyMigrated = true
      throw new Error("step failed after changing the config")
    }

    await startBackground()

    expect(sameRaw(await readRawPrimary(), original)).toBe(true)
    const copies = preservedCopiesOf(await snapshot(), original)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("migration-failed")
  })

  it("keeps the original and writes nothing when the migrated value still fails the schema", async () => {
    const original: RawPrimary = { value: previousVersionConfig(), meta: PREVIOUS_META }
    await seedPrimary(original.value, original.meta)
    const tracker = trackPrimaryWrites()
    migration.hook = async (version, config, real) => {
      const migrated = await real(version, config)
      return { ...migrated, contextMenu: { enabled: "yes" } }
    }

    await startBackground()

    expect(tracker.writes).toEqual([])
    expect(sameRaw(await readRawPrimary(), original)).toBe(true)
    const copies = preservedCopiesOf(await snapshot(), original)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("invalid-schema")
  })
})

describe("two startups that see different originals", () => {
  it("keeps both when the stored config is replaced between them", async () => {
    const first: RawPrimary = { value: corruptConfig("first"), meta: CURRENT_META }
    const second: RawPrimary = { value: corruptConfig("second"), meta: CURRENT_META }

    await seedPrimary(first.value, first.meta)
    await startBackground()
    await seedPrimary(second.value, second.meta)
    await startBackground()

    const all = await snapshot()
    expect(preservedCopiesOf(all, first)).toHaveLength(1)
    expect(preservedCopiesOf(all, second)).toHaveLength(1)
    expect(sameRaw(await readRawPrimary(), second)).toBe(true)
  })
})
