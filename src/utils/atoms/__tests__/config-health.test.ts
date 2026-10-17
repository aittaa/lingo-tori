import { createStore } from "jotai"
import { beforeEach, describe, expect, it, vi } from "vitest"
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

const EDIT = { language: { sourceCode: "auto", targetCode: "kor", level: "beginner" } } as const

beforeEach(() => {
  resetStorage()
})

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

  it("stops following once nothing watches it", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { store, health, unsubscribe } = await mounted()
    unsubscribe()

    await seedPrimary(corruptConfig(), CURRENT_META)
    await settle()

    expect(store.get(health.configUnusableReasonAtom)).toBeNull()
  })
})
