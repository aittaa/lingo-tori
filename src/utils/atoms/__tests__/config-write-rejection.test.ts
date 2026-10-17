// @vitest-environment jsdom
// Who is told when a config write is refused.
//
// Most settings controls start a write and do not wait for it (`void setField(...)`). A refused
// write (an unusable stored config) rejects, and the screen reports that in its own way; the
// rejection must not ALSO reach the page as an uncaught error. Callers that do wait must still get
// the rejection: a handled copy for the ones that ignore it must not swallow the real one.
//
// Real code: `writeConfigAtom`, the field atoms and the provider patch through a Jotai store, over
// the extension's in-memory browser storage. Unhandled rejections are read from the process's own
// `unhandledRejection` event, the one a page reports as an uncaught error, not from a spy on the
// code under test.

import type { RawPrimary } from "../../config/__tests__/preservation-test-kit"
import type { Config } from "@/types/config/config"
import { createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isAPIProviderConfig } from "@/types/config/provider"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  validConfig,
  watchUnhandledRejections,
} from "../../config/__tests__/preservation-test-kit"

const EDIT = { language: { sourceCode: "auto", targetCode: "kor", level: "beginner" } } as const

let unhandled: ReturnType<typeof watchUnhandledRejections>

beforeEach(() => {
  resetStorage()
  unhandled = watchUnhandledRejections()
})

afterEach(() => {
  unhandled.stop()
})

async function openAtoms() {
  vi.resetModules()
  const atoms = await import("../config")
  const entities = await import("../entity-config")
  const store = createStore()
  return {
    atoms,
    entities,
    store,
    // A write that is waited for queues behind every write started before it, so it settles only
    // once they have: the point after which a refusal of an earlier one has happened.
    queuedBehind: () => store.set(atoms.writeConfigAtom, {}).catch(() => undefined),
  }
}

describe("a write that nothing waits for, refused over a stored config that cannot be used", () => {
  let before: RawPrimary

  beforeEach(async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    before = await readRawPrimary()
  })

  it("through writeConfigAtom reaches the page as no unhandled rejection", async () => {
    const { atoms, store, queuedBehind } = await openAtoms()

    void store.set(atoms.writeConfigAtom, EDIT)
    await queuedBehind()
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("through a field atom (what a settings switch writes through) reaches the page as no unhandled rejection", async () => {
    const { atoms, store, queuedBehind } = await openAtoms()

    void store.set(atoms.configFieldsAtomMap.floatingButton, { enabled: false })
    await queuedBehind()
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("stores nothing", async () => {
    const { atoms, store, queuedBehind } = await openAtoms()

    void store.set(atoms.writeConfigAtom, EDIT)
    await queuedBehind()
    await unhandled.flush()

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })
})

describe("a write that is waited for, refused over a stored config that cannot be used", () => {
  beforeEach(async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
  })

  it("rejects writeConfigAtom with the typed refusal", async () => {
    const { atoms, store } = await openAtoms()

    await expect(store.set(atoms.writeConfigAtom, EDIT)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
    })
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("rejects a field atom with the typed refusal", async () => {
    const { atoms, store } = await openAtoms()

    await expect(
      store.set(atoms.configFieldsAtomMap.floatingButton, { enabled: false }),
    ).rejects.toMatchObject({ name: "ConfigRecoveryRequiredError" })
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("leaves a caller that handles the rejection itself with nothing unhandled", async () => {
    const { atoms, store } = await openAtoms()
    const handled = vi.fn<(error: unknown) => void>()

    void store.set(atoms.writeConfigAtom, EDIT).catch(handled)
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1))
    await unhandled.flush()

    expect(handled.mock.calls[0]?.[0]).toMatchObject({ name: "ConfigRecoveryRequiredError" })
    expect(unhandled.reasons).toEqual([])
  })
})

describe("controls: a write over a stored config that can be used", () => {
  beforeEach(async () => {
    await seedPrimary(validConfig(), CURRENT_META)
  })

  it("that nothing waits for is stored, with nothing unhandled", async () => {
    const { atoms, store } = await openAtoms()

    void store.set(atoms.writeConfigAtom, EDIT)
    await vi.waitFor(async () =>
      expect(((await readRawPrimary()).value as Config).language.targetCode).toBe("kor"),
    )
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("that is waited for resolves once the edit is stored, and shows the stored value", async () => {
    const { atoms, store } = await openAtoms()

    await expect(store.set(atoms.writeConfigAtom, EDIT)).resolves.toBeUndefined()

    expect(((await readRawPrimary()).value as Config).language).toEqual(EDIT.language)
    expect(store.get(atoms.configAtom).language).toEqual(EDIT.language)
    await unhandled.flush()
    expect(unhandled.reasons).toEqual([])
  })
})

// The provider list's switch calls the provider patch and does not wait for it. The patch is its own
// atom over `writeConfigAtom`, so it must not hold the refusal in a promise of its own either.
describe("the provider patch (the provider list's switch) refused over a stored config that cannot be used", () => {
  // The list was showing a provider when the stored config stopped being usable.
  const shown = validConfig().providersConfig.find(isAPIProviderConfig)!

  beforeEach(async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
  })

  it("that nothing waits for reaches the page as no unhandled rejection", async () => {
    const { atoms, entities, store, queuedBehind } = await openAtoms()
    store.set(atoms.configAtom, validConfig())

    void store.set(entities.patchProviderConfigAtom, {
      id: shown.id,
      changes: { enabled: !shown.enabled },
    })
    await queuedBehind()
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("that is waited for rejects with the typed refusal", async () => {
    const { atoms, entities, store } = await openAtoms()
    store.set(atoms.configAtom, validConfig())

    await expect(
      store.set(entities.patchProviderConfigAtom, {
        id: shown.id,
        changes: { enabled: !shown.enabled },
      }),
    ).rejects.toMatchObject({ name: "ConfigRecoveryRequiredError" })
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })
})

describe("the provider patch over a stored config that can be used", () => {
  const stored = validConfig().providersConfig.find(isAPIProviderConfig)!

  beforeEach(async () => {
    await seedPrimary(validConfig(), CURRENT_META)
  })

  it("that nothing waits for is stored, with nothing unhandled", async () => {
    const { atoms, entities, store } = await openAtoms()
    // The list's switch only writes what the page has shown.
    store.set(atoms.configAtom, validConfig())

    void store.set(entities.patchProviderConfigAtom, {
      id: stored.id,
      changes: { enabled: !stored.enabled },
    })
    await vi.waitFor(async () =>
      expect(
        ((await readRawPrimary()).value as Config).providersConfig.find(
          (provider) => provider.id === stored.id,
        )?.enabled,
      ).toBe(!stored.enabled),
    )
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("for a provider that is gone rejects the returned promise instead of throwing out of the setter", async () => {
    const { atoms, entities, store } = await openAtoms()
    store.set(atoms.configAtom, validConfig())
    let returned: unknown

    expect(() => {
      returned = store.set(entities.patchProviderConfigAtom, {
        id: "no-such-provider",
        changes: { enabled: false },
      })
    }).not.toThrow()

    await expect(returned).rejects.toThrow("Provider no longer exists")
  })
})

describe("an updater that throws on the config shown", () => {
  beforeEach(async () => {
    await seedPrimary(validConfig(), CURRENT_META)
  })

  it("rejects the returned promise instead of throwing out of the setter", async () => {
    const { atoms, store } = await openAtoms()
    const failure = new Error("the updater cannot apply")
    let returned: unknown

    expect(() => {
      returned = store.set(atoms.writeConfigAtom, () => {
        throw failure
      })
    }).not.toThrow()

    await expect(returned).rejects.toBe(failure)
  })

  it("starts nothing, so the next write still goes through", async () => {
    const { atoms, store } = await openAtoms()

    await store
      .set(atoms.writeConfigAtom, () => {
        throw new Error("the updater cannot apply")
      })
      .catch(() => undefined)
    await store.set(atoms.writeConfigAtom, EDIT)

    expect(((await readRawPrimary()).value as Config).language.targetCode).toBe("kor")
  })
})
