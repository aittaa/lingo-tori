import { afterEach, expect, it, vi } from "vitest"
import { createByosJobRegistry } from "../cancellation"
afterEach(() => vi.useRealTimers())
const sender = {
  id: "fixture",
  tab: { id: 1 },
  frameId: 0,
  documentId: "document-A",
  url: "https://example.test/a",
}
const requestId = "11111111-1111-4111-8111-111111111111"
it("same-document SPA navigation cancels, different documents/frames do not", async () => {
  vi.useFakeTimers()
  const jobs = createByosJobRegistry("fixture")
  let signal: AbortSignal | undefined
  const job = jobs.invoke(sender, requestId, async (captured) => {
    signal = captured
    return new Promise((_resolve, reject) =>
      captured.addEventListener("abort", () => reject(captured.reason), { once: true }),
    )
  })
  jobs.cancel({ ...sender, documentId: "document-B" }, requestId)
  jobs.cancel({ ...sender, frameId: 1 }, requestId)
  expect(signal?.aborted).toBe(false)
  jobs.cancel({ ...sender, url: "https://example.test/b#route" }, requestId)
  await expect(job).rejects.toMatchObject({ name: "AbortError" })
  expect(signal?.aborted).toBe(true)
})
it("older runtimes bind cancellation to origin, tab and frame across SPA routes", async () => {
  vi.useFakeTimers()
  const jobs = createByosJobRegistry("fixture")
  const older = { ...sender, documentId: undefined }
  let signal: AbortSignal | undefined
  const job = jobs.invoke(older, requestId, async (captured) => {
    signal = captured
    return new Promise((_resolve, reject) =>
      captured.addEventListener("abort", () => reject(captured.reason), { once: true }),
    )
  })
  jobs.cancel({ ...older, url: "https://other.test/a" }, requestId)
  jobs.cancel({ ...older, tab: { id: 2 } }, requestId)
  expect(signal?.aborted).toBe(false)
  jobs.cancel({ ...older, url: "https://example.test/b" }, requestId)
  await expect(job).rejects.toMatchObject({ name: "AbortError" })
})
