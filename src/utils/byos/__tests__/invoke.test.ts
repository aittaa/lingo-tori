import { expect, it, vi } from "vitest"
import { invokeByos } from "../invoke"
import { sendByosMessage } from "../messages"
vi.mock("../messages", () => ({ sendByosMessage: vi.fn<typeof sendByosMessage>() }))
it("sends a request-bound cancellation across extension messaging and rejects completion", async () => {
  const mock = vi.mocked(sendByosMessage)
  let resolve: (value: { text: string }) => void = () => {}
  mock.mockImplementation((type) =>
    type === "lingotoriByosInvoke"
      ? new Promise((done) => {
          resolve = done
        })
      : Promise.resolve(undefined),
  )
  const controller = new AbortController()
  const job = invokeByos({ model: "fixture", text: "source" }, controller.signal)
  const first = mock.mock.calls[0]
  expect(first?.[0]).toBe("lingotoriByosInvoke")
  controller.abort()
  expect(mock.mock.calls[1]).toEqual([
    "lingotoriByosCancel",
    (first![1] as { requestId: string }).requestId,
  ])
  resolve({ text: "late output" })
  await expect(job).rejects.toMatchObject({ name: "AbortError" })
})
