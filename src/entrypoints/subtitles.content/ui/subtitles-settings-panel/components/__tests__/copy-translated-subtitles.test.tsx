// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SubtitleCopyPhase, translatedSubtitlesCopyStatusAtom } from "../../../../atoms"
import { CopyTranslatedSubtitles } from "../copy-translated-subtitles"
import { COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS } from "../copy-translated-subtitles.constants"

const copyTranslatedSubtitles = vi.hoisted(() => vi.fn<(...args: any[]) => any>())

vi.mock("../../../subtitles-ui-context", () => ({
  useSubtitlesUI: () => ({ copyTranslatedSubtitles }),
}))

function renderComponent(initialStatus?: { phase: SubtitleCopyPhase; progress: number | null }) {
  const store = createStore()
  if (initialStatus) {
    store.set(translatedSubtitlesCopyStatusAtom, initialStatus)
  }

  render(
    <Provider store={store}>
      <CopyTranslatedSubtitles />
    </Provider>,
  )
  return store
}

function setStatus(
  store: ReturnType<typeof createStore>,
  phase: SubtitleCopyPhase,
  progress: number | null,
) {
  act(() => store.set(translatedSubtitlesCopyStatusAtom, { phase, progress }))
}

describe("download translated subtitles", () => {
  afterEach(() => {
    copyTranslatedSubtitles.mockReset()
    cleanup()
    vi.useRealTimers()
  })

  it("delegates downloads and keeps delayed feedback through checking and preparing", async () => {
    vi.useFakeTimers()
    const store = renderComponent()
    const button = screen.getByRole("button")
    fireEvent.click(button)
    expect(copyTranslatedSubtitles).toHaveBeenCalledTimes(1)

    setStatus(store, SubtitleCopyPhase.Checking, null)
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()
    expect(button).toBeDisabled()

    await act(() =>
      vi.advanceTimersByTime(COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS - 1),
    )
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()

    setStatus(store, SubtitleCopyPhase.Preparing, 0)
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()

    await act(() => vi.advanceTimersByTime(1))
    const message = screen.getByText("subtitles.actions.copyPreparing")
    expect(message).toBeInTheDocument()
    expect(message).toHaveClass("text-muted-foreground")
    expect(message).not.toHaveTextContent("(0%)")

    setStatus(store, SubtitleCopyPhase.Idle, null)
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()
    expect(button).not.toBeDisabled()
  })

  it("delays the preparing message and does not show preparing progress", async () => {
    vi.useFakeTimers()
    const store = renderComponent()
    const button = screen.getByRole("button")

    setStatus(store, SubtitleCopyPhase.Preparing, 0)
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()
    expect(button).toBeDisabled()

    await act(() =>
      vi.advanceTimersByTime(COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS - 1),
    )
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()

    await act(() => vi.advanceTimersByTime(1))
    const message = screen.getByText("subtitles.actions.copyPreparing")
    expect(message).toBeInTheDocument()
    expect(message).toHaveClass("text-muted-foreground")
    expect(message).not.toHaveTextContent("(0%)")
  })

  it("restarts the preparing delay after a visible preparing message is cleared", async () => {
    vi.useFakeTimers()
    const store = renderComponent()

    setStatus(store, SubtitleCopyPhase.Preparing, 0)
    await act(() => vi.advanceTimersByTime(COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS))
    expect(screen.getByText("subtitles.actions.copyPreparing")).toBeInTheDocument()

    setStatus(store, SubtitleCopyPhase.Translating, 20)
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()

    setStatus(store, SubtitleCopyPhase.Preparing, 0)
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()

    await act(() =>
      vi.advanceTimersByTime(COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS - 1),
    )
    expect(screen.queryByText("subtitles.actions.copyPreparing")).not.toBeInTheDocument()

    await act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText("subtitles.actions.copyPreparing")).toBeInTheDocument()
  })

  it("renders translating progress immediately and completion as success", () => {
    const store = renderComponent()
    const button = screen.getByRole("button")

    setStatus(store, SubtitleCopyPhase.Translating, 45)
    const translatingMessage = screen.getByText("subtitles.actions.copyTranslating (45%)")
    expect(translatingMessage).toBeInTheDocument()
    expect(translatingMessage).toHaveClass("text-muted-foreground")
    expect(button).toBeDisabled()

    setStatus(store, SubtitleCopyPhase.Complete, null)
    const completeMessage = screen.getByText("subtitles.actions.copyComplete")
    expect(completeMessage).toBeInTheDocument()
    expect(completeMessage).toHaveClass("text-success")
    expect(button).not.toBeDisabled()
  })
  it("enables a fresh copy gesture only after preparation and exposes retry after rejection", () => {
    const store = renderComponent()
    const button = screen.getByRole("button")
    setStatus(store, SubtitleCopyPhase.Ready, null)
    expect(screen.getByText("subtitles.actions.copyReady")).toBeInTheDocument()
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(copyTranslatedSubtitles).toHaveBeenCalledTimes(1)
    setStatus(store, SubtitleCopyPhase.Copying, null)
    expect(button).toBeDisabled()
    setStatus(store, SubtitleCopyPhase.CopyFailed, null)
    expect(button).toHaveAccessibleName("subtitles.actions.copyRetry")
    expect(screen.getByText("subtitles.actions.copyFailed")).toBeInTheDocument()
    fireEvent.click(button)
    expect(copyTranslatedSubtitles).toHaveBeenCalledTimes(2)
  })
})
