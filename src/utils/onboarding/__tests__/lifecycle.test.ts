import type { OnboardingEvent, OnboardingState, OnboardingStatus } from "../lifecycle"
import { createStore } from "jotai"
import { afterEach, describe, expect, it } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { storage } from "#imports"
import { writeConfigAtom } from "@/utils/atoms/config"
import { addBackup, getAllBackupsWithMetadata } from "@/utils/backup/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  isInstallOnboardingEligible,
  nextOnboardingStatus,
  ONBOARDING_STORAGE_KEY,
  onboardingActionSchema,
  readOnboardingState,
} from "../lifecycle"

const onboardingKey = `local:${ONBOARDING_STORAGE_KEY}` as const

afterEach(() => fakeBrowser.reset())

describe("isInstallOnboardingEligible", () => {
  it.each([
    // [reason, hadStoredConfig, eligible]
    ["install", false, true],
    // An existing config — valid, or unreadable and rebuilt — means setup already happened.
    ["install", true, false],
    ["update", false, false],
    ["update", true, false],
    ["chrome_update", false, false],
    ["shared_module_update", false, false],
  ])("%s with hadStoredConfig=%s -> %s", (reason, hadStoredConfig, eligible) => {
    expect(isInstallOnboardingEligible({ reason, hadStoredConfig })).toBe(eligible)
  })
})

describe("nextOnboardingStatus", () => {
  const table: Record<OnboardingState, Record<OnboardingEvent, OnboardingStatus | null>> = {
    // Never enrolled: only the install path may start it, and nothing else writes.
    absent: { init: "pending", complete: null, dismiss: null },
    // An unreadable record is never written over, whatever the event.
    invalid: { init: null, complete: null, dismiss: null },
    pending: { init: "pending", complete: "completed", dismiss: "dismissed" },
    // Later is not final: the question can still be answered afterwards.
    dismissed: { init: "dismissed", complete: "completed", dismiss: "dismissed" },
    // Terminal.
    completed: { init: "completed", complete: "completed", dismiss: "completed" },
  }

  for (const [state, events] of Object.entries(table) as Array<
    [OnboardingState, Record<OnboardingEvent, OnboardingStatus | null>]
  >) {
    for (const [event, expected] of Object.entries(events) as Array<
      [OnboardingEvent, OnboardingStatus | null]
    >) {
      it(`${state} + ${event} -> ${expected}`, () => {
        expect(nextOnboardingStatus(state, event)).toBe(expected)
      })
    }
  }
})

describe("readOnboardingState", () => {
  it("reports absent when nothing is stored", async () => {
    expect(await readOnboardingState()).toBe("absent")
  })

  it.each(["pending", "dismissed", "completed"] as const)("reads %s", async (status) => {
    await storage.setItem(onboardingKey, { version: 1, status })
    expect(await readOnboardingState()).toBe(status)
  })

  it.each([
    ["a future version", { version: 2, status: "completed" }],
    ["a bare string", "completed"],
    ["a missing version", { status: "completed" }],
    ["an unknown status", { version: 1, status: "later" }],
    ["a non-object", 7],
  ])("reports invalid for %s without touching it", async (_label, value) => {
    await storage.setItem(onboardingKey, value)
    expect(await readOnboardingState()).toBe("invalid")
    expect(await storage.getItem(onboardingKey)).toEqual(value)
  })
})

describe("onboardingActionSchema", () => {
  it("accepts a completion with a language the picker offers, and a dismissal", () => {
    expect(onboardingActionSchema.safeParse({ event: "complete", targetCode: "kor" }).success).toBe(
      true,
    )
    expect(onboardingActionSchema.safeParse({ event: "dismiss" }).success).toBe(true)
  })

  it.each([true, false])(
    "accepts retryCompletionOnly=%s on a completion",
    (retryCompletionOnly) => {
      expect(
        onboardingActionSchema.parse({ event: "complete", targetCode: "kor", retryCompletionOnly }),
      ).toEqual({ event: "complete", targetCode: "kor", retryCompletionOnly })
    },
  )

  it("leaves retryCompletionOnly out unless it is sent", () => {
    const parsed = onboardingActionSchema.parse({ event: "complete", targetCode: "kor" })
    expect("retryCompletionOnly" in parsed).toBe(false)
  })

  it.each([
    { event: "complete" },
    { event: "complete", targetCode: "auto" },
    { event: "complete", targetCode: "ko" },
    { event: "complete", targetCode: "kor", retryCompletionOnly: "true" },
    { event: "complete", targetCode: "kor", retryCompletionOnly: 1 },
    { event: "init" },
    {},
  ])("rejects %j", (value) => {
    expect(onboardingActionSchema.safeParse(value).success).toBe(false)
  })
})

describe("profile-local storage", () => {
  it("keeps the record out of backups and untouched by restoring a config", async () => {
    const record = { version: 1, status: "pending" }
    await storage.setItem(onboardingKey, record)
    await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, structuredClone(DEFAULT_CONFIG))

    await addBackup(structuredClone(DEFAULT_CONFIG), "1.0.0")
    const backups = await getAllBackupsWithMetadata()
    expect(backups).toHaveLength(1)
    expect(JSON.stringify(backups)).not.toContain(ONBOARDING_STORAGE_KEY)
    expect(Object.keys(backups[0]!.config)).not.toContain(ONBOARDING_STORAGE_KEY)

    // Restoring or importing goes through the config writer, which only knows the config key.
    const restored = structuredClone(DEFAULT_CONFIG)
    restored.language.targetCode = "kor"
    await createStore().set(writeConfigAtom, restored)

    expect(await storage.getItem(onboardingKey)).toEqual(record)
    expect(await readOnboardingState()).toBe("pending")
  })

  it("is not a field of the config", () => {
    expect(Object.keys(DEFAULT_CONFIG)).not.toContain(ONBOARDING_STORAGE_KEY)
    expect(ONBOARDING_STORAGE_KEY).not.toBe(CONFIG_STORAGE_KEY)
  })
})
