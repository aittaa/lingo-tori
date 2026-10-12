// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sourceSubtitlesCopyStatusAtom, SubtitleCopyPhase } from "../../../../atoms"
import { CopySourceSubtitles } from "../copy-source-subtitles"

const copySourceSubtitles = vi.hoisted(() => vi.fn<() => Promise<void>>())
vi.mock("../../../subtitles-ui-context", () => ({
  useSubtitlesUI: () => ({ copySourceSubtitles }),
}))
afterEach(() => {
  cleanup()
  copySourceSubtitles.mockReset()
})

describe("source subtitle copy feedback", () => {
  it("disables preparation/copying, announces ready/success, and enables explicit retry", () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <CopySourceSubtitles />
      </Provider>,
    )
    const button = screen.getByRole("button", { name: "subtitles.actions.copySource" })
    fireEvent.click(button)
    expect(copySourceSubtitles).toHaveBeenCalledTimes(1)
    const setPhase = (phase: SubtitleCopyPhase) =>
      act(() => {
        store.set(sourceSubtitlesCopyStatusAtom, { phase, progress: null })
      })
    setPhase(SubtitleCopyPhase.Checking)
    expect(button).toBeDisabled()
    expect(screen.getByText("subtitles.actions.copyPreparing")).toBeInTheDocument()
    setPhase(SubtitleCopyPhase.Ready)
    expect(button).toBeEnabled()
    expect(screen.getByText("subtitles.actions.copyReady")).toHaveAttribute("aria-live", "polite")
    fireEvent.click(button)
    expect(copySourceSubtitles).toHaveBeenCalledTimes(2)
    setPhase(SubtitleCopyPhase.Copying)
    expect(button).toBeDisabled()
    setPhase(SubtitleCopyPhase.CopyFailed)
    expect(button).toHaveAccessibleName("subtitles.actions.copyRetry")
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(copySourceSubtitles).toHaveBeenCalledTimes(3)
    setPhase(SubtitleCopyPhase.Complete)
    expect(screen.getByText("subtitles.actions.copyComplete")).toHaveClass("text-success")
  })
})
