import type { ApiUsageHistory } from "../api-usage-history"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createApiUsageHistoryRecorder,
  apiUsageHistorySchema,
  emptyApiUsageHistory,
  emptyUsageMetrics,
  historyFeatureTotals,
  localUsageDate,
} from "../api-usage-history"
import { createApiUsageIdentity } from "../api-usage-identity"
import { readResponsesTokens, readSdkTokens } from "../api-usage-tokens"

afterEach(() => vi.unstubAllEnvs())
const byos = createApiUsageIdentity({
  id: "byos-row",
  provider: "byos",
  name: "private label",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: "gpt-6.1-sol" },
})
function store(initial: unknown = null) {
  let value = structuredClone(initial)
  return {
    read: vi.fn<() => Promise<unknown>>(async () => structuredClone(value)),
    write: vi.fn<(history: ApiUsageHistory) => Promise<void>>(async (history) => {
      value = structuredClone(history)
    }),
  }
}

describe("local date/model/feature aggregates", () => {
  it("counts dispatch before midnight and reported tokens on the completion day without moving either during flush", async () => {
    vi.stubEnv("TZ", "UTC")
    let now = Date.parse("2026-10-12T23:59:59Z")
    const recorder = createApiUsageHistoryRecorder(store(), () => now)
    recorder.attempt("dictionary", byos)
    now = Date.parse("2026-10-13T00:00:01Z")
    recorder.result("dictionary", byos, { inputTokens: 100, outputTokens: 20 })
    recorder.attempt("dictionary", byos)
    const value = (await recorder.snapshot()).history!
    expect(value.days["2026-10-12"]?.[byos.id]?.dictionary).toMatchObject({
      requests: 1,
      results: 0,
      inputReports: 0,
    })
    expect(value.days["2026-10-13"]?.[byos.id]?.dictionary).toMatchObject({
      requests: 1,
      results: 1,
      inputReports: 1,
      inputTokens: 100,
      outputTokens: 20,
    })
  })

  it("uses device local dates across timezone changes and never rewrites existing dates", async () => {
    const timestamp = Date.parse("2026-10-13T01:00:00Z")
    const recorder = createApiUsageHistoryRecorder(store(), () => timestamp)
    vi.stubEnv("TZ", "UTC")
    expect(localUsageDate(timestamp)).toBe("2026-10-13")
    recorder.attempt("pageTranslation", byos)
    vi.stubEnv("TZ", "America/Los_Angeles")
    expect(localUsageDate(timestamp)).toBe("2026-10-12")
    recorder.attempt("pageTranslation", byos)
    const history = (await recorder.snapshot()).history!
    expect(history.days["2026-10-13"]?.[byos.id]?.pageTranslation?.requests).toBe(1)
    expect(history.days["2026-10-12"]?.[byos.id]?.pageTranslation?.requests).toBe(1)
  })

  it("resumes persisted totals and retains failed concurrent writes without fabricating earlier days", async () => {
    const memory = store()
    memory.write.mockRejectedValueOnce(new Error("synthetic failure"))
    const recorder = createApiUsageHistoryRecorder(memory)
    for (let i = 0; i < 20; i++) {
      recorder.attempt("dictionary", byos)
      recorder.result("dictionary", byos, { inputTokens: 5 })
    }
    const snapshot = await recorder.snapshot()
    expect(snapshot.historyIncomplete).toBe(true)
    const totals = historyFeatureTotals(snapshot.history!, "0000-01-01", "9999-12-31", [byos.id])
    expect(totals.dictionary).toMatchObject({
      requests: 20,
      results: 20,
      inputReports: 20,
      outputReports: 0,
      inputTokens: 100,
    })
    const restarted = createApiUsageHistoryRecorder(memory)
    restarted.attempt("dictionary", byos)
    const next = (await restarted.snapshot()).history!
    expect(Object.keys(next.days)).toHaveLength(1)
    expect(
      historyFeatureTotals(next, "0000-01-01", "9999-12-31", [byos.id]).dictionary.requests,
    ).toBe(21)
  })

  it("opens empty history without copying lifetime counts or writing any history", async () => {
    const memory = store()
    expect(await createApiUsageHistoryRecorder(memory).snapshot()).toEqual({
      history: emptyApiUsageHistory(),
      historyIncomplete: false,
    })
    expect(memory.write).not.toHaveBeenCalled()
  })

  it("preserves malformed/future history instead of replacing it with zeros", async () => {
    const future = { version: 2, preserve: "synthetic existing data" }
    const memory = store(future)
    const recorder = createApiUsageHistoryRecorder(memory)
    recorder.attempt("dictionary", byos)
    expect(await recorder.snapshot()).toEqual({ history: null, historyIncomplete: true })
    expect(await memory.read()).toEqual(future)
    expect(memory.write).not.toHaveBeenCalled()
  })

  it.each(["features", "models", "days"])(
    "rejects individually safe cells whose token sum overflows across %s",
    (boundary) => {
      const history = emptyApiUsageHistory()
      history.since = 1
      history.models[byos.id] = byos
      const metrics = {
        ...emptyUsageMetrics(),
        results: 1,
        inputReports: 1,
        inputTokens: Number.MAX_SAFE_INTEGER,
      }
      history.days["2026-10-12"] = { [byos.id]: { dictionary: metrics } }
      expect(apiUsageHistorySchema.safeParse(history).success).toBe(true)
      const extra = { ...metrics, inputTokens: 1 }
      if (boundary === "features") history.days["2026-10-12"][byos.id]!.sentenceAnalysis = extra
      else if (boundary === "days")
        history.days["2026-10-13"] = { [byos.id]: { dictionary: extra } }
      else {
        const other = { ...byos, id: "a".repeat(64) }
        history.models[other.id] = other
        history.days["2026-10-12"][other.id] = { dictionary: extra }
      }
      expect(apiUsageHistorySchema.safeParse(history).success).toBe(false)
    },
  )

  it("preserves stored safe totals when a new report would overflow an aggregate", async () => {
    const history = emptyApiUsageHistory()
    history.since = 1
    history.models[byos.id] = byos
    history.days["2026-10-12"] = {
      [byos.id]: {
        dictionary: {
          ...emptyUsageMetrics(),
          results: 1,
          inputReports: 1,
          inputTokens: Number.MAX_SAFE_INTEGER,
        },
      },
    }
    const memory = store(history)
    const recorder = createApiUsageHistoryRecorder(memory, () => Date.parse("2026-10-13T12:00:00Z"))
    recorder.result("sentenceAnalysis", byos, { inputTokens: 1 })
    expect(await recorder.snapshot()).toEqual({ history: null, historyIncomplete: true })
    expect(memory.write).not.toHaveBeenCalled()
    expect(await memory.read()).toEqual(history)
  })

  it.each(["since", "inputReports", "outputReports"] as const)(
    "preserves inconsistent stored history with invalid %s",
    async (field) => {
      const history = emptyApiUsageHistory()
      history.since = 1
      history.models[byos.id] = byos
      const metrics = { ...emptyUsageMetrics(), requests: 1, results: 1 }
      history.days["2026-10-12"] = { [byos.id]: { dictionary: metrics } }
      if (field === "since") history.since = null
      else metrics[field === "inputReports" ? "inputTokens" : "outputTokens"] = 1
      const memory = store(history)
      const recorder = createApiUsageHistoryRecorder(memory)
      recorder.attempt("dictionary", byos)
      expect(await recorder.snapshot()).toEqual({ history: null, historyIncomplete: true })
      expect(memory.write).not.toHaveBeenCalled()
      expect(await memory.read()).toEqual(history)
    },
  )

  it("accepts genuine reported zero and empty unreported token fields", async () => {
    const recorder = createApiUsageHistoryRecorder(store())
    recorder.result("dictionary", byos, { inputTokens: 0 })
    recorder.result("dictionary", byos, {})
    const snapshot = await recorder.snapshot()
    expect(snapshot.historyIncomplete).toBe(false)
    expect(Object.values(snapshot.history!.days)[0]?.[byos.id]?.dictionary).toMatchObject({
      results: 2,
      inputReports: 1,
      outputReports: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  it("distinguishes BYOS, providers and configured rows while excluding arbitrary sensitive labels", () => {
    const base = {
      id: "private-row",
      name: "https://private.test?api_key=secret",
      provider: "openai" as const,
      enabled: true,
      apiKey: "synthetic-secret",
      baseURL: "https://private.test",
      model: {
        model: "gpt-4o-mini" as const,
        isCustomModel: true as const,
        customModel: "gpt-6.1-sol",
      },
    }
    const api = createApiUsageIdentity(base)
    expect(api.id).not.toBe(byos.id)
    expect(createApiUsageIdentity({ ...base, id: "another-row" }).id).not.toBe(api.id)
    expect(createApiUsageIdentity({ ...base, provider: "azure" }).id).not.toBe(api.id)
    const unknown = createApiUsageIdentity({
      ...base,
      model: { ...base.model, customModel: "https://private.test?token=secret" },
    })
    expect(unknown.model).toBeNull()
    expect(JSON.stringify([api, unknown])).not.toMatch(/private|secret|https/)
  })
})

describe("reported token availability", () => {
  it("keeps missing/malformed token fields unknown and preserves a genuinely reported zero", () => {
    expect(readResponsesTokens({ input_tokens: 0, output_tokens: 3 })).toMatchObject({
      inputTokens: 0,
      outputTokens: 3,
    })
    expect(readResponsesTokens({ input_tokens: "100", output_tokens: -1 })).toBeUndefined()
    expect(readResponsesTokens(null)).toBeUndefined()
    expect(readSdkTokens({ inputTokens: 0, outputTokens: 0, raw: {} })).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
    })
    expect(
      readSdkTokens({
        inputTokens: 0,
        outputTokens: 0,
        raw: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it("does not add cache tokens again to normalized input or reasoning again to output", () => {
    expect(
      readSdkTokens({
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 60 },
        outputTokenDetails: { reasoningTokens: 10 },
        raw: { input_tokens: 100, output_tokens: 20 },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20 })
  })
})
