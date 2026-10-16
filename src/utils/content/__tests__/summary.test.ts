import { beforeEach, describe, expect, it, vi } from "vitest"
import { generateArticleSummary } from "@/utils/content/summary"
import { TranslationCancelledError } from "@/utils/request/cancellation"

/**
 * How `generateArticleSummary` logs a generation that did not produce a summary. A summary is
 * optional context, so every failure answers `null`; what differs is the log. A request whose
 * owner left on purpose is not a failure: the queue aborts its signal with the
 * `TranslationCancelledError` it rejects the task with, and the provider's own abort error is only
 * the echo of that. Anything else keeps its error log, including an error that merely has the name
 * AbortError, and an abort that is not a cancellation (the queue's timeout aborts the signal too).
 */

const loggerSpies = vi.hoisted(() => ({
  log: vi.fn<(...args: any[]) => void>(),
  info: vi.fn<(...args: any[]) => void>(),
  warn: vi.fn<(...args: any[]) => void>(),
  error: vi.fn<(...args: any[]) => void>(),
}))
vi.mock("@/utils/logger", () => ({ logger: loggerSpies }))

const routing = { providerRef: { kind: "local", config: { id: "p" } } } as never
const PAGE_TEXT = "Page body that is long enough to summarise."
const FAILURE_LOG = "Failed to generate article summary:"

const abortError = () => new DOMException("aborted", "AbortError")

/** A signal aborted the way the queue aborts a drained task's. */
function abortedBy(reason: unknown): AbortSignal {
  const controller = new AbortController()
  controller.abort(reason)
  return controller.signal
}

function summarize(generate: () => Promise<string>, signal?: AbortSignal) {
  return generateArticleSummary("Title", PAGE_TEXT, routing, { signal, generate })
}

const errorLogs = () => loggerSpies.error.mock.calls.filter(([message]) => message === FAILURE_LOG)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("generateArticleSummary: a generation that was cancelled on purpose", () => {
  it("is not logged as a failure when the owner left and the provider answers with its abort error", async () => {
    const signal = abortedBy(new TranslationCancelledError("1:session"))

    const result = await summarize(() => Promise.reject(abortError()), signal)

    expect(result).toBeNull()
    expect(loggerSpies.error).not.toHaveBeenCalled()
    expect(loggerSpies.warn).not.toHaveBeenCalled()
    expect(loggerSpies.info).toHaveBeenCalledWith("Article summary generation cancelled")
  })

  it("is not logged as a failure when the cancellation itself is what the provider path throws", async () => {
    const reason = new TranslationCancelledError("1:session")

    const result = await summarize(() => Promise.reject(reason), abortedBy(reason))

    expect(result).toBeNull()
    expect(loggerSpies.error).not.toHaveBeenCalled()
  })
})

describe("generateArticleSummary: what is still a failure", () => {
  it("logs a genuine provider error", async () => {
    const result = await summarize(() => Promise.reject(new Error("provider down")))

    expect(result).toBeNull()
    expect(errorLogs()).toHaveLength(1)
  })

  it("logs an error named AbortError while its own signal is not aborted", async () => {
    const result = await summarize(() => Promise.reject(abortError()), new AbortController().signal)

    expect(result).toBeNull()
    expect(errorLogs()).toHaveLength(1)
    expect(loggerSpies.info).not.toHaveBeenCalledWith("Article summary generation cancelled")
  })

  it("logs a cancellation error that is not tied to an abort of its own signal", async () => {
    const result = await summarize(
      () => Promise.reject(new TranslationCancelledError("1:other")),
      new AbortController().signal,
    )

    expect(result).toBeNull()
    expect(errorLogs()).toHaveLength(1)
  })

  it("logs an error named AbortError when there is no signal at all", async () => {
    const result = await summarize(() => Promise.reject(abortError()))

    expect(result).toBeNull()
    expect(errorLogs()).toHaveLength(1)
  })

  it("logs an abort that is not a cancellation (the queue's timeout aborts the signal with its own error)", async () => {
    const signal = abortedBy(new Error("Task t1 timed out after 20000ms"))

    const result = await summarize(() => Promise.reject(abortError()), signal)

    expect(result).toBeNull()
    expect(errorLogs()).toHaveLength(1)
  })
})

describe("generateArticleSummary: unchanged", () => {
  it("returns the trimmed summary and logs only at info", async () => {
    const result = await summarize(() => Promise.resolve("  A short summary.  "))

    expect(result).toBe("A short summary.")
    expect(loggerSpies.error).not.toHaveBeenCalled()
    expect(loggerSpies.warn).not.toHaveBeenCalled()
  })

  it("answers null without calling the provider when there is no text", async () => {
    const generate = vi.fn<() => Promise<string>>()

    const result = await generateArticleSummary("Title", "   ", routing, { generate })

    expect(result).toBeNull()
    expect(generate).not.toHaveBeenCalled()
  })
})
