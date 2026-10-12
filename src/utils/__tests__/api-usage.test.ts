import { afterEach, describe, expect, it, vi } from "vitest"
import { API_USAGE_FEATURES, createApiUsageRecorder, emptyApiUsage } from "../api-usage"
import { installApiUsageObserver, withApiUsage } from "../api-usage-tracking"

afterEach(() => installApiUsageObserver(() => {}))

function memoryStore(initial: unknown = null) {
  let value = structuredClone(initial)
  return {
    read: vi.fn<() => Promise<unknown>>(async () => structuredClone(value)),
    write: vi.fn<(next: unknown) => Promise<void>>(async (next: unknown) => {
      value = structuredClone(next)
    }),
  }
}

describe("local API usage persistence", () => {
  it("persists concurrent feature/transport increments and resumes after worker restart", async () => {
    const store = memoryStore()
    const recorder = createApiUsageRecorder(store, () => 1234)
    for (let i = 0; i < 30; i++) {
      recorder.record("pageTranslation", "api")
      recorder.record("dictionary", "byos")
    }
    expect((await recorder.snapshot()).usage?.counts.pageTranslation.api).toBe(30)
    const restarted = createApiUsageRecorder(store, () => 5678)
    restarted.record("pageTranslation", "api")
    expect(await restarted.snapshot()).toMatchObject({
      incomplete: false,
      usage: {
        since: 1234,
        counts: { pageTranslation: { api: 31, byos: 0 }, dictionary: { api: 0, byos: 30 } },
      },
    })
    const saved = await store.read()
    expect(Object.keys(saved as object).sort()).toEqual(["counts", "since", "version"])
    expect(Object.keys((saved as ReturnType<typeof emptyApiUsage>).counts)).toEqual([
      ...API_USAGE_FEATURES,
    ])
  })

  it("retains failed writes for the next flush, reports failure and never blocks callers", async () => {
    const store = memoryStore()
    store.write.mockRejectedValueOnce(new Error("synthetic storage failure"))
    const recorder = createApiUsageRecorder(store)
    expect(() => recorder.record("selectionTranslation", "api")).not.toThrow()
    const snapshot = await recorder.snapshot()
    expect(snapshot.incomplete).toBe(true)
    expect(snapshot.usage?.counts.selectionTranslation.api).toBe(1)
  })

  it("preserves malformed or future data and reports unknown totals", async () => {
    const future = { version: 2, unrelated: "preserve me" }
    const store = memoryStore(future)
    const recorder = createApiUsageRecorder(store)
    recorder.record("dictionary", "api")
    expect(await recorder.snapshot()).toEqual({ usage: null, incomplete: true })
    expect(store.write).not.toHaveBeenCalled()
    expect(await store.read()).toEqual(future)
  })

  it("does not start a counting period or write empty data just by opening settings", async () => {
    const store = memoryStore()
    expect(await createApiUsageRecorder(store).snapshot()).toEqual({
      usage: emptyApiUsage(),
      incomplete: false,
    })
    expect(store.write).not.toHaveBeenCalled()
  })
})

describe("outbound fetch observation", () => {
  it("returns the original translation response even when aggregate storage keeps failing", async () => {
    const store = memoryStore()
    store.write.mockRejectedValue(new Error("synthetic persistent storage failure"))
    const recorder = createApiUsageRecorder(store)
    installApiUsageObserver(recorder.record)
    const fetcher = vi.fn<typeof fetch>(async () => new Response("translated result"))
    const response = await withApiUsage("pageTranslation", fetcher)("https://example.test")
    expect(await response.text()).toBe("translated result")
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await recorder.snapshot()).toEqual({ usage: null, incomplete: true })
    expect(await store.read()).toBeNull()
  })

  it("counts each dispatch including retry, leaves response/body untouched and persists only aggregates", async () => {
    const store = memoryStore()
    const recorder = createApiUsageRecorder(store)
    installApiUsageObserver(recorder.record)
    const response = new Response("synthetic output")
    const failure = new Error("synthetic failure")
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(failure).mockResolvedValue(response)
    const tracked = withApiUsage("subtitlesTranslation", fetcher)
    const init = {
      method: "POST",
      body: "synthetic private batch",
      headers: { Authorization: "synthetic-secret" },
    }
    await expect(tracked("https://example.test/private-path", init)).rejects.toBe(failure)
    expect(await tracked("https://example.test/private-path", init)).toBe(response)
    expect(fetcher.mock.calls[1]?.[1]).toBe(init)
    expect(response.bodyUsed).toBe(false)
    expect((await recorder.snapshot()).usage?.counts.subtitlesTranslation.api).toBe(2)
    expect(JSON.stringify(await store.read())).not.toMatch(
      /synthetic|example|private|Authorization/,
    )
  })

  it("counts one batch dispatch and counts no cache-only work or pre-aborted fetch", async () => {
    const observer = vi.fn<(feature: string, transport: string) => void>()
    installApiUsageObserver(observer)
    const fetcher = vi.fn<typeof fetch>(async () => new Response())
    const tracked = withApiUsage("pageTranslation", fetcher)
    await tracked("https://example.test", { body: "one\n%%\ntwo\n%%\nthree", method: "POST" })
    // Cached results do not reach the transport wrapper.
    expect(observer).toHaveBeenCalledExactlyOnceWith("pageTranslation", "api")
    await tracked(new Request("https://example.test", { signal: AbortSignal.abort() }))
    expect(observer).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("returns a failed/truncated stream unchanged and does not recount stream chunks or cancellation", async () => {
    const observer = vi.fn<(feature: string, transport: string) => void>()
    installApiUsageObserver(observer)
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("stream failed"))
        },
      }),
    )
    const tracked = withApiUsage("videoSummary", async () => response)
    const result = await tracked("https://example.test")
    await expect(result.text()).rejects.toThrow("stream failed")
    expect(observer).toHaveBeenCalledExactlyOnceWith("videoSummary", "api")
  })

  it("ignores observer failure while preserving the request promise", () => {
    installApiUsageObserver(() => {
      throw new Error("synthetic observer failure")
    })
    const job = Promise.resolve(new Response())
    const tracked = withApiUsage("dictionary", () => job)
    expect(tracked("https://example.test")).toBe(job)
  })
})
