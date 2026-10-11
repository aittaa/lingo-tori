import type {
  AnalyticsFeature,
  FeatureUsageContext,
  FeatureUsedEventProperties,
  SurfaceByFeature,
} from "@/types/analytics"

type WithTiming<T> = T extends unknown
  ? Omit<T, "latency_ms"> & { startedAt: number; finishedAt?: number }
  : never
type WithoutOutcome<T> = T extends unknown ? Omit<T, "outcome" | "finishedAt"> : never

export type FeatureUsedEventInput = WithTiming<FeatureUsedEventProperties>

/** Everything `trackFeatureUsed` needs except the outcome, which the attempt decides. */
export type FeatureAttemptInput = WithoutOutcome<FeatureUsedEventInput>

export function createFeatureUsageContext<F extends AnalyticsFeature>(
  feature: F,
  surface: SurfaceByFeature[NoInfer<F>],
  startedAt = Date.now(),
): FeatureUsageContext<F> {
  return {
    feature,
    surface,
    startedAt,
  }
}

export function getLatencyMs(startedAt: number, finishedAt = Date.now()): number {
  return Math.max(0, finishedAt - startedAt)
}

export function buildFeatureUsedEventProperties(
  input: FeatureUsedEventInput,
): FeatureUsedEventProperties {
  const { startedAt, finishedAt = Date.now(), ...properties } = input
  return {
    ...properties,
    latency_ms: getLatencyMs(startedAt, finishedAt),
  }
}

/** Legacy callers remain source-compatible; no events are collected or transmitted. */
export async function trackFeatureUsed(_input: FeatureUsedEventInput): Promise<void> {}

export async function trackFeatureAttempt<T>(
  _context: FeatureAttemptInput,
  run: () => Promise<T>,
): Promise<T> {
  return await run()
}
