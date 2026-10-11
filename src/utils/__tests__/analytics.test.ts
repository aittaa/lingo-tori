import { describe, expect, it, vi } from "vitest"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { trackFeatureAttempt, trackFeatureUsed } from "@/utils/analytics"

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn<(...args: unknown[]) => void>() }))
vi.mock("@/utils/message", () => ({ sendMessage }))
const context = {
  feature: ANALYTICS_FEATURE.PAGE_TRANSLATION,
  surface: ANALYTICS_SURFACE.POPUP,
  startedAt: 1,
  translation_mode: "bilingual",
  target_language: "eng",
  provider: "unknown",
  backend_kind: "unknown",
} as const

describe("telemetry removal", () => {
  it("does not message the background when legacy instrumentation fires", async () => {
    await trackFeatureUsed({ ...context, outcome: "success" })
    expect(sendMessage).not.toHaveBeenCalled()
  })
  it("preserves return values and failures of instrumented operations", async () => {
    await expect(trackFeatureAttempt(context, async () => "translation")).resolves.toBe(
      "translation",
    )
    const error = new Error("provider failed")
    await expect(
      trackFeatureAttempt(context, async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
