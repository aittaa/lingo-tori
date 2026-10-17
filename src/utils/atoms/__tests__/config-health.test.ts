import { createStore } from "jotai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  ConfigConflictError,
  ConfigOutcomeUnknownError,
  ConfigRecoveryRequiredError,
  ConfigRefusedError,
  ConfigUnavailableError,
  PreservationError,
} from "@/utils/config/errors"
import {
  corruptConfig,
  CURRENT_META,
  failWrites,
  resetStorage,
  seedPrimary,
  settle,
  validConfig,
} from "../../config/__tests__/preservation-test-kit"
import { configWriteFailureAtom, describeWriteFailure } from "../config-health"

const warn = vi.hoisted(() => vi.fn<(...args: unknown[]) => void>())

// The health atom's own first read of the stored config can be made to answer late: it reads when
// it is called and answers once `release()` is called. Every other read is the real one, and the
// status watcher (which reads through its own module-internal reader) is not held.
const firstRead = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }))

vi.mock("@/utils/config/status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/config/status")>()
  return {
    ...actual,
    getConfigView: async () => {
      const view = await actual.getConfigView()
      await firstRead.gate
      return view
    },
  }
})

vi.mock("@/utils/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/logger")>()
  return { ...actual, logger: { ...actual.logger, warn } }
})

const EDIT = { language: { sourceCode: "auto", targetCode: "kor", level: "beginner" } } as const

beforeEach(() => {
  resetStorage()
  warn.mockReset()
  firstRead.gate = undefined
})

/** Holds the atoms' first read of the stored config until `release()`. */
function holdTheFirstRead() {
  let release!: () => void
  firstRead.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return release
}

async function openAtoms() {
  vi.resetModules()
  const health = await import("../config-health")
  const atoms = await import("../config")
  return { health, atoms, store: createStore() }
}

describe("describeWriteFailure", () => {
  it.each([
    { error: new ConfigRefusedError("field-not-allowed-for-sender"), kind: "refused" },
    { error: new ConfigOutcomeUnknownError(), kind: "unknown-outcome" },
    { error: new ConfigUnavailableError(), kind: "unavailable" },
    { error: new ConfigConflictError(), kind: "conflict" },
    { error: new PreservationError("full"), kind: "preservation" },
    { error: new Error("Config is invalid"), kind: "other" },
    { error: "not even an error", kind: "other" },
  ])("names $kind for $error", ({ error, kind }) => {
    expect(describeWriteFailure(error)).toEqual({ kind })
  })

  it("says nothing for a stored config that cannot be used: its own banner covers that", () => {
    expect(describeWriteFailure(new ConfigRecoveryRequiredError("invalid-schema"))).toBeNull()
  })
})

describe("the last change that was not saved", () => {
  it("is recorded when the saving part could not save, and cleared by the next change that is", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { health, atoms, store } = await openAtoms()
    failWrites((keys) => keys.includes("config"))

    await expect(store.set(atoms.writeConfigAtom, EDIT)).rejects.toMatchObject({
      name: "ConfigUnavailableError",
    })
    expect(store.get(health.configWriteFailureAtom)).toEqual({ kind: "unavailable" })

    vi.restoreAllMocks()
    await store.set(atoms.writeConfigAtom, EDIT)
    expect(store.get(health.configWriteFailureAtom)).toBeNull()
  })

  it("is logged, so that a screen with no banner still leaves a trace", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { atoms, store } = await openAtoms()
    failWrites((keys) => keys.includes("config"))

    await store.set(atoms.writeConfigAtom, EDIT).catch(() => undefined)

    expect(warn).toHaveBeenCalledWith(
      "A change to the settings was not saved",
      expect.objectContaining({ name: "ConfigUnavailableError" }),
    )
  })

  it("is not recorded for an unusable stored config, which has its own banner", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const { health, atoms, store } = await openAtoms()

    await expect(store.set(atoms.writeConfigAtom, EDIT)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
    })

    expect(store.get(health.configWriteFailureAtom)).toBeNull()
  })

  it("starts empty", () => {
    expect(createStore().get(configWriteFailureAtom)).toBeNull()
  })
})

describe("whether the stored config can be used", () => {
  async function mounted() {
    const { health, store } = await openAtoms()
    const unsubscribe = store.sub(health.configUnusableReasonAtom, () => {})
    await settle()
    return { store, health, unsubscribe }
  }

  it("is nothing for a usable config and for an empty profile", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const usable = await mounted()
    expect(usable.store.get(usable.health.configUnusableReasonAtom)).toBeNull()
    usable.unsubscribe()

    resetStorage()
    const empty = await mounted()
    expect(empty.store.get(empty.health.configUnusableReasonAtom)).toBeNull()
    empty.unsubscribe()
  })

  it("names why the stored config cannot be used", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const { store, health, unsubscribe } = await mounted()

    expect(store.get(health.configUnusableReasonAtom)).toBe("invalid-schema")
    unsubscribe()
  })

  it("follows the stored config while it is watched", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { store, health, unsubscribe } = await mounted()

    await seedPrimary(corruptConfig(), CURRENT_META)
    await settle()
    expect(store.get(health.configUnusableReasonAtom)).toBe("invalid-schema")

    await seedPrimary(validConfig(), CURRENT_META)
    await settle()
    expect(store.get(health.configUnusableReasonAtom)).toBeNull()
    unsubscribe()
  })

  it("leaves no listener on the browser's storage once nothing watches it", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { unsubscribe } = await mounted()
    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(true)

    unsubscribe()

    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(false)
  })

  it("stops following once nothing watches it", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { store, health, unsubscribe } = await mounted()
    unsubscribe()

    await seedPrimary(corruptConfig(), CURRENT_META)
    await settle()

    expect(store.get(health.configUnusableReasonAtom)).toBeNull()
  })
})

// The first read of the stored config and the watcher both publish a view. A read that answers
// after the watcher has delivered a newer view describes an older state and must not replace it:
// otherwise the banner disappears while every change is still refused, or stays after recovery.
describe("a first read of the stored config that answers late", () => {
  async function mounted() {
    const { health, store } = await openAtoms()
    const unsubscribe = store.sub(health.configUnusableReasonAtom, () => {})
    await settle()
    return { store, health, unsubscribe }
  }

  it("does not hide the banner of a config that became unusable while it was being read", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const release = holdTheFirstRead()
    const { store, health, unsubscribe } = await mounted()

    await seedPrimary(corruptConfig(), CURRENT_META)
    await settle()
    expect(store.get(health.configUnusableReasonAtom)).toBe("invalid-schema")
    release()
    await settle()

    expect(store.get(health.configUnusableReasonAtom)).toBe("invalid-schema")
    unsubscribe()
  })

  it("does not keep the banner of a config that became usable while it was being read", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const release = holdTheFirstRead()
    const { store, health, unsubscribe } = await mounted()

    await seedPrimary(validConfig(), CURRENT_META)
    await settle()
    expect(store.get(health.configUnusableReasonAtom)).toBeNull()
    release()
    await settle()

    expect(store.get(health.configUnusableReasonAtom)).toBeNull()
    unsubscribe()
  })

  it("still shows what it read when nothing newer arrived (a control)", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const release = holdTheFirstRead()
    const { store, health, unsubscribe } = await mounted()
    expect(store.get(health.configUnusableReasonAtom)).toBeNull()

    release()
    await settle()

    expect(store.get(health.configUnusableReasonAtom)).toBe("invalid-schema")
    unsubscribe()
  })

  it("shows nothing after it is unmounted, whatever it reads (a control)", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const release = holdTheFirstRead()
    const { store, health, unsubscribe } = await mounted()

    unsubscribe()
    release()
    await settle()

    expect(store.get(health.configUnusableReasonAtom)).toBeNull()
  })
})
