// @vitest-environment jsdom
import type { SelectionToolbarInlineError } from "../inline-error"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sendMessage } from "@/utils/message"
import { SelectionToolbarErrorAlert } from "../selection-toolbar-error-alert"

vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

const SETTINGS_URL =
  "chrome-extension://test/options.html#/api-providers?section=feature-provider-selectionTranslation"

const PROVIDER_REQUIRED: SelectionToolbarInlineError = {
  title: "Translation failed",
  description: "Choose a provider first",
  action: { label: "Open settings", url: SETTINGS_URL },
}

describe("SelectionToolbarErrorAlert", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("opens the action's page through the background, once, only when its button is pressed", () => {
    render(createElement(SelectionToolbarErrorAlert, { error: PROVIDER_REQUIRED }))

    expect(screen.getByText("Translation failed")).toBeInTheDocument()
    expect(screen.getByText("Choose a provider first")).toBeInTheDocument()
    expect(sendMessage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith("openPage", { url: SETTINGS_URL, active: true })
  })

  it("shows a plain message without a button when the error has no action", () => {
    render(
      createElement(SelectionToolbarErrorAlert, {
        error: { title: "Translation failed", description: "Rate limited" },
      }),
    )

    expect(screen.getByText("Rate limited")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("renders nothing without an error", () => {
    const { container } = render(createElement(SelectionToolbarErrorAlert, { error: null }))

    expect(container).toBeEmptyDOMElement()
  })
})
