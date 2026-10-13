import { z } from "zod"
import { storage } from "#imports"
import { langCodeISO6393Schema } from "@/lib/languages"

/**
 * Where a browser profile stands in the first-run language question. A key of its own in local
 * storage, never a field of the config, so backup, import and sync cannot carry one profile's
 * progress to another. Only the background writes it (see `background/onboarding.ts`); every other
 * context reads it with `readOnboardingState`.
 */
export const ONBOARDING_STORAGE_KEY = "onboarding"

export const ONBOARDING_ROUTE = "/onboarding" as const

export const onboardingStatusSchema = z.enum(["pending", "completed", "dismissed"])
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>

export const onboardingRecordSchema = z.object({
  version: z.literal(1),
  status: onboardingStatusSchema,
})
export type OnboardingRecord = z.infer<typeof onboardingRecordSchema>

/**
 * What storage says: a status, nothing at all ("absent" — a profile that was never enrolled, which
 * covers every existing user), or something this build cannot read ("invalid"). Neither of the
 * last two is ever written over.
 */
export type OnboardingState = OnboardingStatus | "absent" | "invalid"

export async function readOnboardingState(): Promise<OnboardingState> {
  const stored = await storage.getItem<unknown>(`local:${ONBOARDING_STORAGE_KEY}`)
  if (stored === null || stored === undefined) return "absent"
  const parsed = onboardingRecordSchema.safeParse(stored)
  return parsed.success ? parsed.data.status : "invalid"
}

/**
 * Only a first install that found no stored config may enrol. `onInstalled` also fires for updates
 * and for browser profile restores, and an existing config means the person has already been
 * through setup.
 */
export function isInstallOnboardingEligible({
  reason,
  hadStoredConfig,
}: {
  reason: string
  hadStoredConfig: boolean
}): boolean {
  return reason === "install" && !hadStoredConfig
}

export type OnboardingEvent = "init" | "complete" | "dismiss"

/**
 * The status an event leads to, or null when the profile is not enrolled (absent or invalid) and
 * the event must leave storage alone. `completed` is terminal; `dismissed` can still be completed,
 * so a person who chose Later can answer the question afterwards.
 */
export function nextOnboardingStatus(
  current: OnboardingState,
  event: OnboardingEvent,
): OnboardingStatus | null {
  if (current === "completed") return "completed"
  if (current === "absent") return event === "init" ? "pending" : null
  if (current === "invalid") return null
  if (current === "pending") {
    if (event === "complete") return "completed"
    return event === "dismiss" ? "dismissed" : "pending"
  }
  // dismissed
  return event === "complete" ? "completed" : "dismissed"
}

/**
 * What the options page asks the background to do. Completing carries the chosen language, so the
 * background can save it and finish onboarding as one step that a second tab cannot overtake.
 *
 * A completion always saves `targetCode`, except one with `retryCompletionOnly`. The page sends
 * that flag only to retry a completion that answered `lifecycle-save-failed`: the language is
 * already saved, so the retry records completion without writing it again, which keeps a settings
 * change made since then.
 */
export const onboardingActionSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("complete"),
    targetCode: langCodeISO6393Schema,
    retryCompletionOnly: z.boolean().optional(),
  }),
  z.object({ event: z.literal("dismiss") }),
])
export type OnboardingAction = z.infer<typeof onboardingActionSchema>

export type OnboardingTransitionResult =
  | { ok: true; status: OnboardingStatus }
  // The profile was never enrolled (or its record is unreadable): nothing was written.
  | { ok: false; reason: "not-eligible" }
  // Completing could not save the language, so nothing changed.
  | { ok: false; reason: "target-save-failed" }
  // The record could not be written. After a completion the language is already saved, and
  // sending the completion again with `retryCompletionOnly` finishes the missing step only.
  | { ok: false; reason: "lifecycle-save-failed" }
