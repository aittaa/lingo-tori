// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emptyApiUsageHistory, localUsageDate, offsetUsageDate } from "@/utils/api-usage-history"
import { createApiUsageIdentity } from "@/utils/api-usage-identity"
import { usageModelLabel } from "../history-chart"
import { HistoryDashboard } from "../history-dashboard"

vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))
afterEach(cleanup)
const byos = createApiUsageIdentity({
  id: "byos-row",
  name: "synthetic",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: "gpt-6.1-sol" },
})
const api = createApiUsageIdentity({
  id: "api-row",
  name: "synthetic",
  provider: "openai",
  enabled: true,
  apiKey: "synthetic-secret",
  model: { model: "gpt-4o-mini", isCustomModel: true, customModel: "gpt-6.1-sol" },
})
function fixture() {
  const history = emptyApiUsageHistory()
  const day = localUsageDate()
  history.since = Date.now() - 1000
  history.models = { [byos.id]: byos, [api.id]: api }
  history.days[day] = {
    [byos.id]: {
      dictionary: {
        requests: 2,
        results: 2,
        inputReports: 1,
        outputReports: 1,
        inputTokens: 20,
        outputTokens: 5,
      },
    },
    [api.id]: {
      dictionary: {
        requests: 1,
        results: 1,
        inputReports: 1,
        outputReports: 1,
        inputTokens: 1000,
        outputTokens: 50,
      },
    },
  }
  return { history, day }
}

describe("date/model token dashboard", () => {
  it.each(["deepl", "deeplx"] as const)(
    "labels model-less %s requests by provider without claiming a private model",
    (provider) => {
      const identity = createApiUsageIdentity({
        id: "synthetic-row",
        name: "synthetic",
        provider,
        enabled: true,
        apiKey: "synthetic-secret",
        baseURL: "https://synthetic.test",
      })
      expect(identity.model).toBeNull()
      expect(usageModelLabel(identity)).toBe(
        `${provider} / API (${identity.providerKey.slice(0, 6)})`,
      )
      expect(usageModelLabel({ ...api, model: null })).toContain(
        "options.apiUsage.history.privateModel",
      )
    },
  )
  it("defaults to BYOS input tokens and excludes hidden API tokens from graph and table totals", () => {
    const { history } = fixture()
    render(<HistoryDashboard history={history} locale="en" />)
    expect(screen.getByRole("combobox")).toHaveValue("inputTokens")
    expect(screen.getByRole("checkbox", { name: /ChatGPT.*gpt-6.1-sol/ })).toBeChecked()
    const apiCheckbox = screen.getByRole("checkbox", { name: /openai \/ API/ })
    expect(apiCheckbox).not.toBeChecked()
    const table = screen.getByRole("table", { name: "options.apiUsage.history.detailsTitle" })
    expect(within(table).getByRole("row", { name: /features.dictionary/ })).toHaveTextContent(
      "20 (options.apiUsage.history.partial)",
    )
    expect(within(table).getByRole("row", { name: /features.dictionary/ })).not.toHaveTextContent(
      "1000",
    )
    fireEvent.click(apiCheckbox)
    expect(within(table).getByRole("row", { name: /features.dictionary/ })).toHaveTextContent(
      "1,020",
    )
    expect(screen.getByText("options.apiUsage.history.visibleTotals")).toBeInTheDocument()
  })

  it("selects a keyboard-focusable model/date segment with Enter and clears selection when hidden", () => {
    const { history, day } = fixture()
    render(<HistoryDashboard history={history} locale="en" />)
    const detailButton = screen.getByRole("button", {
      name: new RegExp(`selectDetails: ${day}, ChatGPT`),
    })
    detailButton.focus()
    expect(detailButton).toHaveFocus()
    fireEvent.keyDown(detailButton, { key: "Enter" })
    expect(detailButton).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("heading", { name: new RegExp(`${day}.*ChatGPT`) })).toBeInTheDocument()
    const byosCheckbox = screen.getByRole("checkbox", { name: /ChatGPT/ })
    fireEvent.click(byosCheckbox)
    expect(screen.getByText("options.apiUsage.history.noVisible")).toBeInTheDocument()
    fireEvent.click(byosCheckbox)
    expect(
      screen.getByRole("heading", { name: "options.apiUsage.history.periodDetails" }),
    ).toBeInTheDocument()
  })

  it("keeps missing tokens unreported and allows Space selection without pretending activity is empty", () => {
    const { history, day } = fixture()
    history.days[day]![byos.id]!.dictionary = {
      requests: 3,
      results: 2,
      inputReports: 0,
      outputReports: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    render(<HistoryDashboard history={history} locale="en" />)
    const button = screen.getByRole("button", {
      name: new RegExp(`selectDetails: ${day}, ChatGPT.*unreported`),
    })
    fireEvent.keyDown(button, { key: " " })
    const row = within(screen.getByRole("table")).getByRole("row", { name: /features.dictionary/ })
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "options.apiUsage.history.unreported",
      "options.apiUsage.history.unreported",
      "3",
      "0/2 · 0/2",
    ])
    expect(screen.queryByText("options.apiUsage.history.empty")).not.toBeInTheDocument()
  })

  it("does not fabricate a historical zero table before recording began", () => {
    const { history, day } = fixture()
    render(<HistoryDashboard history={history} locale="en" />)
    fireEvent.change(screen.getByLabelText("options.apiUsage.history.from"), {
      target: { value: offsetUsageDate(day, -10) },
    })
    fireEvent.change(screen.getByLabelText("options.apiUsage.history.to"), {
      target: { value: offsetUsageDate(day, -9) },
    })
    expect(screen.getByText("options.apiUsage.history.olderUnknown")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("shows first-use history separately from lifetime totals and handles invalid periods", () => {
    const { rerender } = render(<HistoryDashboard history={emptyApiUsageHistory()} locale="en" />)
    expect(screen.getByText("options.apiUsage.history.empty")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    const { history, day } = fixture()
    rerender(<HistoryDashboard history={history} locale="en" />)
    fireEvent.change(screen.getByLabelText("options.apiUsage.history.from"), {
      target: { value: offsetUsageDate(day, 1) },
    })
    expect(screen.getByRole("alert")).toHaveTextContent("options.apiUsage.history.invalidRange")
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})
