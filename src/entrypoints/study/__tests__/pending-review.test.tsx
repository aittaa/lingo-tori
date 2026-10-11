// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { createState, reviewCard, saveNote } from "@/utils/learning/core"
import { sendLearningMessage } from "@/utils/learning/messages"
import { Study } from "../main"
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: vi.fn<() => void>() }) }))
vi.mock("@/utils/learning/messages", () => ({
  sendLearningMessage: vi.fn<typeof sendLearningMessage>(),
}))
it("lost review response pins A, blocks sync/import and retries A before displaying B", async () => {
  let state = createState()
  for (const id of ["A", "B"])
    state = saveNote(state, {
      id,
      term: id,
      language: "eng",
      meaning: id,
      context: "",
      sourceUrl: "",
      updatedAt: 1,
    })
  let lost = true
  const mock = vi.mocked(sendLearningMessage)
  mock.mockImplementation(async (type, data) => {
    if (type === "lingotoriState") return state
    if (type === "lingotoriSyncStatus") return { url: "http://127.0.0.1:4317", configured: true }
    if (type === "lingotoriReview") {
      state = reviewCard(state, data as Parameters<typeof reviewCard>[1])
      if (lost) {
        lost = false
        throw new Error("response lost after durable save")
      }
      return state
    }
    throw new Error("unexpected operation")
  })
  render(<Study />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Reveal meaning" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Reveal meaning" }))
  fireEvent.click(screen.getByRole("button", { name: "Good" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Operation failed"))
  expect(screen.getByRole("heading", { name: "A" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled()
  expect(screen.getByLabelText("Import JSON")).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }))
  expect(mock.mock.calls.some(([type]) => type === "lingotoriSync")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "Good" }))
  await waitFor(() => expect(screen.getByRole("heading", { name: "B" })).toBeInTheDocument())
  const reviews = mock.mock.calls.filter(([type]) => type === "lingotoriReview")
  expect(reviews).toHaveLength(2)
  expect(reviews[0]?.[1]).toEqual(reviews[1]?.[1])
  expect(state.reviews).toHaveLength(1)
})
