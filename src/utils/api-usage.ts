import { z } from "zod"

export const API_USAGE_FEATURES = [
  "pageTranslation",
  "selectionTranslation",
  "subtitlesTranslation",
  "dictionary",
  "sentenceAnalysis",
  "customAction",
  "noteSuggestion",
  "pageContext",
  "subtitlesContext",
  "videoSummary",
  "subtitlesSegmentation",
  "languageDetection",
  "sharedRequests",
] as const
export const apiUsageFeatureSchema = z.enum(API_USAGE_FEATURES)
export type ApiUsageFeature = z.infer<typeof apiUsageFeatureSchema>
export type ApiUsageTransport = "api" | "byos"
export const API_USAGE_STORAGE_KEY = "local:apiUsageV1" as const

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const countersSchema = z.strictObject({ api: countSchema, byos: countSchema })
export const apiUsageSchema = z.strictObject({
  version: z.literal(1),
  since: z.number().int().nonnegative().nullable(),
  counts: z.record(apiUsageFeatureSchema, countersSchema),
})
export type ApiUsage = z.infer<typeof apiUsageSchema>
export interface ApiUsageSnapshot {
  usage: ApiUsage | null
  incomplete: boolean
}

export function emptyApiUsage(): ApiUsage {
  return {
    version: 1,
    since: null,
    counts: Object.fromEntries(
      API_USAGE_FEATURES.map((feature) => [feature, { api: 0, byos: 0 }]),
    ) as ApiUsage["counts"],
  }
}

/** One background writer. No payloads or provider identifiers enter this recorder. */
export function createApiUsageRecorder(
  store: {
    read: () => Promise<unknown>
    write: (usage: ApiUsage) => Promise<void>
  },
  now = Date.now,
) {
  const pending = emptyApiUsage()
  let tail = Promise.resolve()
  let incomplete = false

  const flush = async (readWhenEmpty = true) => {
    if (pending.since === null && !readWhenEmpty) return null
    const raw = await store.read()
    // Invalid/future data is preserved, never replaced with zeros.
    const usage = raw === null || raw === undefined ? emptyApiUsage() : apiUsageSchema.parse(raw)
    const delta = structuredClone(pending)
    if (delta.since === null) return usage
    usage.since ??= delta.since
    for (const feature of API_USAGE_FEATURES) {
      for (const transport of ["api", "byos"] as const) {
        const next = usage.counts[feature][transport] + delta.counts[feature][transport]
        if (!Number.isSafeInteger(next)) throw new Error("API usage counter overflow")
        usage.counts[feature][transport] = next
      }
    }
    await store.write(usage)
    // Events arriving during storage I/O belong to the next flush.
    for (const feature of API_USAGE_FEATURES) {
      for (const transport of ["api", "byos"] as const) {
        pending.counts[feature][transport] -= delta.counts[feature][transport]
      }
    }
    if (
      API_USAGE_FEATURES.every(
        (feature) => !pending.counts[feature].api && !pending.counts[feature].byos,
      )
    ) {
      pending.since = null
    }
    return usage
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
  return {
    record(this: void, feature: ApiUsageFeature, transport: ApiUsageTransport) {
      pending.since ??= now()
      pending.counts[feature][transport]++
      void enqueue(() => flush(false))
    },
    async snapshot(): Promise<ApiUsageSnapshot> {
      let usage: ApiUsage | null = null
      await enqueue(async () => {
        usage = await flush()
      })
      return { usage, incomplete }
    },
  }
}
