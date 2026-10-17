// @vitest-environment jsdom
// What the config WRITERS do when the stored config cannot be used.
//
// A writer that cannot read the stored config used to read it as DEFAULT_CONFIG, apply the edit to
// that, and store the result: the user's real settings were replaced by defaults plus one edit, with
// no copy. An ordinary edit over such a stored config is REFUSED now (typed
// `ConfigRecoveryRequiredError`) and the stored pair stays exactly as it was; so is an edit over a
// config that is still being upgraded when startup has finished without upgrading it, which would
// otherwise be stored under its old label.
//
// Real code: `writeConfigAtom` through a Jotai store, `setLocalConfig` (the content-script
// shortcut's writer), `initializeConfig`, over the extension's in-memory browser storage, with the
// settings service answering through the test setup's message seam. Separate module instances over
// the same storage stand in for separate extension contexts (background, options page).

import type { RawPrimary } from "../../config/__tests__/preservation-test-kit"
import type { Config } from "@/types/config/config"
import { isDeepStrictEqual } from "node:util"
import { createStore } from "jotai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import {
  ABSENT,
  corruptConfig,
  CURRENT_META,
  FIXED_MODIFIED_AT,
  holdFirstCall,
  originalIsSafe,
  PRESERVED_PREFIX,
  preservedCopiesOf,
  readPreserved,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  settle,
  snapshot,
  validConfig,
} from "../../config/__tests__/preservation-test-kit"

const EDIT = { language: { sourceCode: "auto", targetCode: "kor", level: "beginner" } } as const

async function openOptionsContext() {
  vi.resetModules()
  const atoms = await import("../config")
  const store = createStore()
  return {
    edit: () => store.set(atoms.writeConfigAtom, EDIT),
  }
}

async function openBackgroundContext() {
  vi.resetModules()
  const init = await import("../../config/init")
  return { start: () => init.initializeConfig() }
}

async function openContentScriptContext() {
  vi.resetModules()
  return import("../../config/storage")
}

interface SuspectCase {
  name: string
  original: () => RawPrimary
}

const SUSPECT_CASES: SuspectCase[] = [
  {
    name: "a current-version object with one wrong-typed field",
    original: () => ({ value: corruptConfig(), meta: CURRENT_META }),
  },
  {
    name: "the same, with no meta stored",
    original: () => ({ value: corruptConfig(), meta: ABSENT }),
  },
  { name: "the corrupted falsy value 0", original: () => ({ value: 0, meta: CURRENT_META }) },
  { name: "a string", original: () => ({ value: "not a config", meta: CURRENT_META }) },
]

beforeEach(() => {
  resetStorage()
})

describe("an ordinary edit over a primary config that is not valid", () => {
  describe.each(SUSPECT_CASES)("$name", ({ original }) => {
    let before: RawPrimary

    beforeEach(async () => {
      const raw = original()
      await seedPrimary(raw.value, raw.meta)
      before = await readRawPrimary()
    })

    it("through writeConfigAtom leaves local:config and its meta exactly as stored", async () => {
      const options = await openOptionsContext()

      await options.edit().catch(() => undefined)

      expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    })

    it("through writeConfigAtom is refused with a ConfigRecoveryRequiredError", async () => {
      const options = await openOptionsContext()

      await expect(options.edit()).rejects.toMatchObject({ name: "ConfigRecoveryRequiredError" })
    })

    it("through setLocalConfig (the content-script shortcut) writes nothing", async () => {
      const content = await openContentScriptContext()

      await content.setLocalConfig(validConfig()).catch(() => undefined)

      expect(sameRaw(await readRawPrimary(), before)).toBe(true)
    })

    it("through setLocalConfig is refused with a ConfigRecoveryRequiredError", async () => {
      const content = await openContentScriptContext()

      await expect(content.setLocalConfig(validConfig())).rejects.toMatchObject({
        name: "ConfigRecoveryRequiredError",
      })
    })
  })
})

describe("controls: an ordinary edit over a valid config", () => {
  it("stores the edit through writeConfigAtom, keeps the rest, and stamps the current version", async () => {
    const config = validConfig()
    await seedPrimary(config, CURRENT_META)
    const options = await openOptionsContext()

    await options.edit()

    const stored = await readRawPrimary()
    expect((stored.value as Config).language).toEqual(EDIT.language)
    expect((stored.value as Config).providersConfig).toEqual(config.providersConfig)
    expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect((stored.meta as any).lastModifiedAt).toBeGreaterThan(FIXED_MODIFIED_AT)
    expect(await readPreserved()).toEqual([])
  })

  it("stores the edit through setLocalConfig and keeps the version label", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const content = await openContentScriptContext()
    const edited = { ...validConfig(), contextMenu: { enabled: false } }

    await content.setLocalConfig(edited)

    const stored = await readRawPrimary()
    expect((stored.value as Config).contextMenu.enabled).toBe(false)
    expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("lets a profile with no stored config take its first edit", async () => {
    const options = await openOptionsContext()

    await options.edit()

    expect(((await readRawPrimary()).value as Config).language.targetCode).toBe("kor")
  })
})

describe("an edit over a valid config that carries an older version label", () => {
  // Current-shaped data under an old label is what an interrupted write leaves behind. If an edit
  // were stored over it with the label unchanged, the next start would run old migration steps over
  // current-shaped data (36 of the 110 labels cannot be upgraded that way). The settings service
  // holds an edit until startup has run; when startup has finished and the label is still old, the
  // upgrade did not happen and the config is treated as unusable: the edit is refused and nothing
  // is stored.
  it("is refused as an unusable config once startup has run, and stores nothing", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION - 2,
      lastModifiedAt: 1,
    })
    const before = await readRawPrimary()
    const options = await openOptionsContext()

    await expect(options.edit()).rejects.toMatchObject({ name: "ConfigRecoveryRequiredError" })

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  it("never leaves changed data under the old version label", async () => {
    await seedPrimary(validConfig(), {
      schemaVersion: CONFIG_SCHEMA_VERSION - 2,
      lastModifiedAt: 1,
    })
    const before = await readRawPrimary()
    const options = await openOptionsContext()

    await options.edit().catch(() => undefined)

    const after = await readRawPrimary()
    const dataChanged = !isDeepStrictEqual(after.value, before.value)
    const labelStale = (after.meta as any)?.schemaVersion !== CONFIG_SCHEMA_VERSION
    expect({ dataChanged, labelStale }).not.toEqual({ dataChanged: true, labelStale: true })
  })
})

describe("a refused edit in a mounted settings screen", () => {
  it("does not stay on screen as if it had been saved", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    vi.resetModules()
    const atoms = await import("../config")
    const store = createStore()
    const unsubscribe = store.sub(atoms.configAtom, () => {})
    try {
      await settle()

      await store.set(atoms.writeConfigAtom, EDIT).catch(() => undefined)
      await settle()

      expect(store.get(atoms.configAtom).language.targetCode).not.toBe(EDIT.language.targetCode)
    } finally {
      unsubscribe()
    }
  })

  it("is taken back by the write itself, so a store that nothing watches shows what is stored", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    vi.resetModules()
    const atoms = await import("../config")
    const store = createStore()

    await expect(store.set(atoms.writeConfigAtom, EDIT)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
    })

    expect(store.get(atoms.configAtom).language.targetCode).not.toBe(EDIT.language.targetCode)
  })
})

describe("two contexts at once over an invalid original", () => {
  it("keeps the original when an options-page edit overlaps the background's startup", async () => {
    const original: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }
    await seedPrimary(original.value, original.meta)
    const background = await openBackgroundContext()
    const options = await openOptionsContext()
    // Whoever reaches a write first (startup's copy or its replacement) is held while the edit runs.
    const gate = holdFirstCall("set", (keys) =>
      keys.some((key) => key === "config" || key === "config$" || key.startsWith(PRESERVED_PREFIX)),
    )

    const startup = background.start()
    await Promise.race([gate.reached, new Promise((resolve) => setTimeout(resolve, 20))])
    await options.edit().catch(() => undefined)
    gate.release()
    await startup.catch(() => undefined)

    expect(await originalIsSafe(original)).toBe(true)
    expect(sameRaw(await readRawPrimary(), original)).toBe(true)
  })

  it("keeps the original when the edit is already waiting on its first read while startup runs", async () => {
    const original: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }
    await seedPrimary(original.value, original.meta)
    const background = await openBackgroundContext()
    const options = await openOptionsContext()
    const editsRead = holdFirstCall("get", (keys) => keys.includes("config"))

    const edit = options.edit().catch((error: unknown) => error)
    await editsRead.reached
    await background.start()
    editsRead.release()

    expect(await edit).toMatchObject({ name: "ConfigRecoveryRequiredError" })
    expect(await originalIsSafe(original)).toBe(true)
    expect(sameRaw(await readRawPrimary(), original)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
  })
})

describe("two contexts at once over a valid config (last writer wins, nothing is lost as an original)", () => {
  it("keeps a valid config valid when an edit and a startup overlap", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const background = await openBackgroundContext()
    const options = await openOptionsContext()

    await Promise.all([background.start(), options.edit()])

    const stored = await readRawPrimary()
    expect(stored.value).toBeTypeOf("object")
    expect((stored.value as Config).language.targetCode).toBe("kor")
    expect((stored.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(await readPreserved()).toEqual([])
  })
})

describe("an edit over a valid config written by a NEWER version of the extension", () => {
  // A downgrade leaves a config with a newer label and, usually, keys this build does not know.
  // `configSchema.safeParse` drops unknown keys, so storing the parsed value would strip them. A
  // label newer than the build is unusable, which refuses the edit. The assertion below also holds
  // for a design that applies the edit without stripping.
  const NEWER_META = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, lastModifiedAt: FIXED_MODIFIED_AT }

  it("does not strip the keys this build does not know, whether it refuses the edit or applies it", async () => {
    const config = { ...validConfig(), keyFromANewerVersion: { setting: "kept" } }
    await seedPrimary(config, NEWER_META)
    const options = await openOptionsContext()

    await options.edit().catch(() => undefined)

    expect(((await readRawPrimary()).value as any).keyFromANewerVersion).toEqual({
      setting: "kept",
    })
  })
})
