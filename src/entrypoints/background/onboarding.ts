import type { LangCodeISO6393 } from "@/lib/languages"
import type { InitializeConfigResult } from "@/utils/config/init"
import type {
  OnboardingAction,
  OnboardingRecord,
  OnboardingState,
  OnboardingStatus,
  OnboardingTransitionResult,
} from "@/utils/onboarding/lifecycle"
import { createStore } from "jotai"
import { storage } from "#imports"
import { writeConfigAtom } from "@/utils/atoms/config"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import {
  isInstallOnboardingEligible,
  nextOnboardingStatus,
  ONBOARDING_STORAGE_KEY,
  onboardingActionSchema,
  readOnboardingState,
} from "@/utils/onboarding/lifecycle"
import { ensureInitializedConfig } from "./config"

async function writeStatus(status: OnboardingStatus) {
  await storage.setItem<OnboardingRecord>(`local:${ONBOARDING_STORAGE_KEY}`, {
    version: 1,
    status,
  })
}

async function saveTargetCode(targetCode: LangCodeISO6393) {
  // A message can wake the worker before its startup initialization (and any config migration) has
  // finished, and the writer falls back to defaults for a config it cannot read.
  await ensureInitializedConfig()
  // The writer rereads storage in its own queue and hands the updater what is persisted now, so
  // only the target changes: edits made since the options page loaded survive.
  await createStore().set(writeConfigAtom, (latest) => ({
    language: { ...latest.language, targetCode },
  }))
}

/**
 * The only writer of the onboarding record. Each instance owns one queue, and the singleton below
 * serves the whole worker.
 */
export function createOnboardingCoordinator() {
  // Reads and writes of the record happen inside this chain, one task at a time, so two tabs — or a
  // completion racing a dismissal — are decided in the order they reach the background, each against
  // the record the previous one left.
  let queue: Promise<unknown> = Promise.resolve()

  function runSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }

  /** Enrols a first install. Resolves true when the pending question should be shown. */
  function handleInstall({
    reason,
    initResult,
  }: {
    reason: string
    initResult: Pick<InitializeConfigResult, "hadStoredConfig">
  }): Promise<boolean> {
    if (!isInstallOnboardingEligible({ reason, hadStoredConfig: initResult.hadStoredConfig })) {
      return Promise.resolve(false)
    }
    return runSerial(async () => {
      try {
        const current = await readOnboardingState()
        const next = nextOnboardingStatus(current, "init")
        if (next === null) return false
        if (next !== current) await writeStatus(next)
        return next === "pending"
      } catch (error) {
        logger.error("[Onboarding] Could not start onboarding", error)
        return false
      }
    })
  }

  async function complete(
    targetCode: LangCodeISO6393,
    retryCompletionOnly: boolean,
  ): Promise<OnboardingTransitionResult> {
    let current: OnboardingState
    try {
      current = await readOnboardingState()
    } catch (error) {
      logger.error("[Onboarding] Could not read the onboarding record", error)
      // Nothing was saved by this attempt. A retry has no language step left, so for it the record
      // is the only thing that failed.
      return {
        ok: false,
        reason: retryCompletionOnly ? "lifecycle-save-failed" : "target-save-failed",
      }
    }

    const next = nextOnboardingStatus(current, "complete")
    if (next === null) return { ok: false, reason: "not-eligible" }
    if (current === "completed") {
      // Another tab finished first and its choice stands: this one writes nothing, not even the language.
      return { ok: true, status: next }
    }

    // An ordinary completion always saves the language it was asked to confirm. Only the page's
    // explicit retry of a completion whose record write failed skips it: that attempt already saved
    // the language, and saving it again could undo a change made since.
    if (!retryCompletionOnly) {
      try {
        await saveTargetCode(targetCode)
      } catch (error) {
        logger.error("[Onboarding] Could not save the target language", error)
        return { ok: false, reason: "target-save-failed" }
      }
    }

    try {
      await writeStatus(next)
    } catch (error) {
      logger.error("[Onboarding] Could not record that onboarding is complete", error)
      return { ok: false, reason: "lifecycle-save-failed" }
    }
    return { ok: true, status: next }
  }

  async function dismiss(): Promise<OnboardingTransitionResult> {
    try {
      const current = await readOnboardingState()
      const next = nextOnboardingStatus(current, "dismiss")
      if (next === null) return { ok: false, reason: "not-eligible" }
      if (next !== current) await writeStatus(next)
      return { ok: true, status: next }
    } catch (error) {
      logger.error("[Onboarding] Could not record the dismissal", error)
      return { ok: false, reason: "lifecycle-save-failed" }
    }
  }

  async function transition(action: OnboardingAction): Promise<OnboardingTransitionResult> {
    // Messages come from other extension contexts; reject anything that is not exactly an action.
    const parsed = onboardingActionSchema.parse(action)
    return runSerial(() =>
      parsed.event === "complete"
        ? complete(parsed.targetCode, parsed.retryCompletionOnly === true)
        : dismiss(),
    )
  }

  return { handleInstall, transition }
}

const onboarding = createOnboardingCoordinator()

export const handleInstallOnboarding = onboarding.handleInstall

export function setupOnboardingMessageHandlers() {
  onMessage("onboardingTransition", (message) => onboarding.transition(message.data))
}
