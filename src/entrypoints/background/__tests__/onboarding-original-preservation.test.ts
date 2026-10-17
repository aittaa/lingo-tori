// Completing onboarding over a stored config that cannot be used.
//
// Onboarding saves the language the user confirmed with `writeConfigAtom` in the background. Over a
// stored config that cannot be validated it used to store defaults plus that language and then
// record onboarding as complete. The save is refused now, nothing is written to the config, and
// onboarding is NOT recorded as complete (so the user is not told it worked).
//
// Real: the onboarding coordinator, `writeConfigAtom`, the onboarding record, over the extension's
// in-memory browser storage. Replaced: the background's config barrier and the message transport.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { ONBOARDING_STORAGE_KEY } from "@/utils/onboarding/lifecycle"
import { createOnboardingCoordinator } from "../onboarding"

vi.mock("../config", () => ({ ensureInitializedConfig: async () => null }))
vi.mock("@/utils/message", () => ({ onMessage: vi.fn<(...args: any[]) => any>() }))

const onboardingKey = `local:${ONBOARDING_STORAGE_KEY}` as const

async function startPending() {
  await storage.setItem(onboardingKey, { version: 1, status: "pending" })
}

beforeEach(() => {
  resetStorage()
})

describe("completing onboarding over a primary config that is not valid", () => {
  const SUSPECT: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }

  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await startPending()
  })

  it("leaves local:config and its meta exactly as stored", async () => {
    const onboarding = createOnboardingCoordinator()

    await onboarding.transition({ event: "complete", targetCode: "kor" })

    expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
  })

  it("reports that the language could not be saved, and does not record completion", async () => {
    const onboarding = createOnboardingCoordinator()

    const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

    expect(result).toEqual({ ok: false, reason: "target-save-failed" })
    expect(await storage.getItem(onboardingKey)).toEqual({ version: 1, status: "pending" })
  })
})

describe("controls: completing onboarding over a valid config", () => {
  it("saves the language, keeps the rest, and records completion", async () => {
    const config = validConfig()
    await seedPrimary(config, CURRENT_META)
    await startPending()
    const onboarding = createOnboardingCoordinator()

    const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

    expect(result).toEqual({ ok: true, status: "completed" })
    const stored = (await readRawPrimary()).value as typeof config
    expect(stored.language.targetCode).toBe("kor")
    expect(stored.providersConfig).toEqual(config.providersConfig)
  })
})
