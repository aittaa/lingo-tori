import type { ApiUsageFeature } from "./api-usage"
import type { ApiUsageIdentity } from "./api-usage-identity"
import type { ReportedTokens } from "./api-usage-tokens"
import { z } from "zod"
import { API_USAGE_FEATURES, apiUsageFeatureSchema } from "./api-usage"
import { apiUsageIdentitySchema } from "./api-usage-identity"

export const API_USAGE_HISTORY_KEY = "local:apiUsageHistoryV1" as const
export const HISTORY_METRICS = [
  "requests",
  "results",
  "inputReports",
  "outputReports",
  "inputTokens",
  "outputTokens",
] as const
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const metricsSchema = z.strictObject({
  requests: count,
  results: count,
  inputReports: count,
  outputReports: count,
  inputTokens: count,
  outputTokens: count,
})
export type UsageMetrics = z.infer<typeof metricsSchema>
const idSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((day) => {
    const parsed = new Date(`${day}T12:00:00Z`)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === day
  })
export const apiUsageHistorySchema = z
  .strictObject({
    version: z.literal(1),
    since: z.number().int().nonnegative().nullable(),
    models: z.record(idSchema, apiUsageIdentitySchema),
    days: z.record(
      localDateSchema,
      z.record(idSchema, z.partialRecord(apiUsageFeatureSchema, metricsSchema)),
    ),
  })
  .superRefine((history, ctx) => {
    if (
      history.since === null &&
      (Object.keys(history.models).length > 0 || Object.keys(history.days).length > 0)
    )
      ctx.addIssue({ code: "custom", message: "History missing observation start" })
    // Every chart/table selection is a subset of these nonnegative totals.
    // Reject unsafe aggregates through the existing unavailable/preserve-data path.
    const totals = emptyUsageMetrics()
    for (const [id, identity] of Object.entries(history.models)) {
      if (id !== identity.id) ctx.addIssue({ code: "custom", message: "History identity mismatch" })
    }
    for (const models of Object.values(history.days)) {
      for (const [id, features] of Object.entries(models)) {
        if (!history.models[id])
          ctx.addIssue({ code: "custom", message: "Unknown history identity" })
        for (const metrics of Object.values(features)) {
          if (metrics.inputReports > metrics.results || metrics.outputReports > metrics.results)
            ctx.addIssue({ code: "custom", message: "Invalid usage coverage" })
          if (
            (metrics.inputReports === 0 && metrics.inputTokens > 0) ||
            (metrics.outputReports === 0 && metrics.outputTokens > 0)
          )
            ctx.addIssue({ code: "custom", message: "Tokens without usage report" })
          for (const key of HISTORY_METRICS) {
            totals[key] += metrics[key]
            if (!Number.isSafeInteger(totals[key]))
              ctx.addIssue({ code: "custom", message: "Usage history aggregate overflow" })
          }
        }
      }
    }
  })
export type ApiUsageHistory = z.infer<typeof apiUsageHistorySchema>
export type HistoryMetric = "inputTokens" | "outputTokens" | "requests"
export function emptyUsageMetrics(): UsageMetrics {
  return {
    requests: 0,
    results: 0,
    inputReports: 0,
    outputReports: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
}
export function emptyApiUsageHistory(): ApiUsageHistory {
  return { version: 1, since: null, models: {}, days: {} }
}
export function localUsageDate(timestamp = Date.now()): string {
  const date = new Date(timestamp)
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`
}
export function offsetUsageDate(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}
export function usageRangeDays(from: string, to: string, offset = 0, limit = 31): string[] {
  if (
    !localDateSchema.safeParse(from).success ||
    !localDateSchema.safeParse(to).success ||
    from > to
  )
    return []
  const days: string[] = []
  for (
    let day = offsetUsageDate(from, offset);
    day <= to && days.length < limit;
    day = offsetUsageDate(day, 1)
  )
    days.push(day)
  return days
}
export function usageRangeLength(from: string, to: string): number {
  if (
    !localDateSchema.safeParse(from).success ||
    !localDateSchema.safeParse(to).success ||
    from > to
  )
    return 0
  return (
    Math.floor((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1
  )
}
export function sumHistoryMetrics(
  features: Partial<Record<ApiUsageFeature, UsageMetrics>>,
): UsageMetrics {
  const sum = emptyUsageMetrics()
  for (const metrics of Object.values(features))
    for (const key of HISTORY_METRICS) sum[key] += metrics[key]
  return sum
}
export function historyFeatureTotals(
  history: ApiUsageHistory,
  from: string,
  to: string,
  visible: readonly string[],
  selection?: { day: string; model: string } | null,
): Record<ApiUsageFeature, UsageMetrics> {
  const totals = Object.fromEntries(
    API_USAGE_FEATURES.map((feature) => [feature, emptyUsageMetrics()]),
  ) as Record<ApiUsageFeature, UsageMetrics>
  for (const [day, models] of Object.entries(history.days)) {
    if (day < from || day > to || (selection && day !== selection.day)) continue
    for (const [id, features] of Object.entries(models)) {
      if (!visible.includes(id) || (selection && id !== selection.model)) continue
      for (const [feature, metrics] of Object.entries(features)) {
        for (const key of HISTORY_METRICS) totals[feature as ApiUsageFeature][key] += metrics[key]
      }
    }
  }
  return totals
}

/** Separate aggregate-only history; lifetime counters are never backfilled or reset. */
export function createApiUsageHistoryRecorder(
  store: { read: () => Promise<unknown>; write: (history: ApiUsageHistory) => Promise<void> },
  now = Date.now,
) {
  let pending = emptyApiUsageHistory()
  let tail = Promise.resolve()
  let incomplete = false
  const flush = async (readWhenEmpty = true): Promise<ApiUsageHistory | null> => {
    if (pending.since === null && !readWhenEmpty) return null
    const raw = await store.read()
    const history =
      raw === null || raw === undefined ? emptyApiUsageHistory() : apiUsageHistorySchema.parse(raw)
    const delta = pending
    if (delta.since === null) return history
    pending = emptyApiUsageHistory()
    try {
      history.since ??= delta.since
      Object.assign(history.models, delta.models)
      for (const [day, models] of Object.entries(delta.days)) {
        const dayModels = (history.days[day] ??= {})
        for (const [id, features] of Object.entries(models)) {
          const modelFeatures = (dayModels[id] ??= {})
          for (const [feature, metrics] of Object.entries(features)) {
            const target = (modelFeatures[feature as ApiUsageFeature] ??= emptyUsageMetrics())
            for (const key of HISTORY_METRICS) {
              const next = target[key] + metrics[key]
              if (!Number.isSafeInteger(next)) throw new Error("Usage history overflow")
              target[key] = next
            }
          }
        }
      }
      apiUsageHistorySchema.parse(history)
      await store.write(history)
      return history
    } catch (error) {
      // Restore the detached delta, including events that arrived while writing.
      pending.since = pending.since === null ? delta.since : Math.min(pending.since, delta.since)
      Object.assign(pending.models, delta.models)
      for (const [day, models] of Object.entries(delta.days)) {
        for (const [id, features] of Object.entries(models)) {
          for (const [feature, metrics] of Object.entries(features)) {
            const target = (((pending.days[day] ??= {})[id] ??= {})[feature as ApiUsageFeature] ??=
              emptyUsageMetrics())
            for (const key of HISTORY_METRICS) target[key] += metrics[key]
          }
        }
      }
      throw error
    }
  }
  const enqueue = (operation: () => Promise<unknown>) => {
    tail = tail.then(operation).then(
      () => {},
      () => {
        incomplete = true
      },
    )
    return tail
  }
  const update = (
    feature: ApiUsageFeature,
    identity: ApiUsageIdentity,
    delta: Partial<UsageMetrics>,
  ) => {
    const timestamp = now()
    const day = localUsageDate(timestamp)
    pending.since ??= timestamp
    pending.models[identity.id] = identity
    const target = (((pending.days[day] ??= {})[identity.id] ??= {})[feature] ??=
      emptyUsageMetrics())
    for (const key of HISTORY_METRICS) target[key] += delta[key] ?? 0
    void enqueue(() => flush(false))
  }
  return {
    attempt(feature: ApiUsageFeature, identity: ApiUsageIdentity) {
      update(feature, identity, { requests: 1 })
    },
    result(feature: ApiUsageFeature, identity: ApiUsageIdentity, tokens: ReportedTokens) {
      update(feature, identity, {
        results: 1,
        inputReports: tokens.inputTokens === undefined ? 0 : 1,
        outputReports: tokens.outputTokens === undefined ? 0 : 1,
        inputTokens: tokens.inputTokens ?? 0,
        outputTokens: tokens.outputTokens ?? 0,
      })
    },
    async snapshot(): Promise<{ history: ApiUsageHistory | null; historyIncomplete: boolean }> {
      let history: ApiUsageHistory | null = null
      await enqueue(async () => {
        history = await flush()
      })
      return { history, historyIncomplete: incomplete }
    },
  }
}
