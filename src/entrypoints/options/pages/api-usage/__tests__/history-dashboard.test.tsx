// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  emptyApiUsageHistory,
  emptyUsageMetrics,
  localUsageDate,
  offsetUsageDate,
} from "@/utils/api-usage-history"
import { createApiUsageIdentity } from "@/utils/api-usage-identity"
import { HistoryDashboard } from "../history-dashboard"
import { historyModels, modelPattern, usageModelLabel, usageModelLabels } from "../history-display"

vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))
afterEach(cleanup)
const subscription = createApiUsageIdentity({
  id: "subscription-row",
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
  history.models = { [subscription.id]: subscription, [api.id]: api }
  history.days[day] = {
    [subscription.id]: {
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
const key = (value: string) => `options.apiUsage.history.${value}`
const table = () => screen.getByRole("table", { name: key("detailsTitle") })
const dictionary = () => within(table()).getByRole("row", { name: /features.dictionary/ })
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent)
const dateButtons = () => within(screen.getByRole("figure")).getAllByRole("button")
function hideApi() {
  fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/ }))
}
function customRange(from: string, to: string) {
  fireEvent.click(screen.getByRole("button", { name: key("rangeCustom") }))
  fireEvent.change(screen.getByLabelText(key("from")), { target: { value: from } })
  fireEvent.change(screen.getByLabelText(key("to")), { target: { value: to } })
}

describe("compact date/model token usage", () => {
  it("defaults to seven days, input tokens and all models, with only used features", () => {
    render(<HistoryDashboard history={fixture().history} locale="en" />)
    expect(screen.getByRole("combobox")).toHaveValue("inputTokens")
    expect(screen.getByRole("button", { name: key("range7") })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(
      screen.getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked),
    ).toBe(true)
    expect(dateButtons()).toHaveLength(7)
    expect(screen.queryByLabelText(key("from"))).not.toBeInTheDocument()
    expect(cells(dictionary())).toEqual([`1,020${key("partial")}`, "100%"])
    expect(within(table()).getAllByRole("rowheader")).toHaveLength(1)
    expect(screen.queryByRole("row", { name: /features.pageTranslation/ })).not.toBeInTheDocument()
  })

  it("shows API-only models initially without an empty hidden-model state", () => {
    const { history, day } = fixture()
    delete history.models[subscription.id]
    delete history.days[day]![subscription.id]
    render(<HistoryDashboard history={history} locale="en" />)
    expect(screen.getByRole("checkbox", { name: /OpenAI/ })).toBeChecked()
    expect(cells(dictionary())).toEqual(["1,000", "100%"])
    expect(screen.queryByText(key("noVisible"))).not.toBeInTheDocument()
  })

  it("keeps filtered summary, rows, shares and expanded counts in the same scope", () => {
    render(<HistoryDashboard history={fixture().history} locale="en" />)
    hideApi()
    expect(cells(dictionary())).toEqual([`20${key("partial")}`, "100%"])
    expect(screen.getByLabelText("options.apiUsage.total")).toHaveTextContent("20")
    expect(screen.getByLabelText("options.apiUsage.total")).not.toHaveTextContent("1,020")
    const details = screen.getByRole("button", { name: key("details") })
    fireEvent.click(details)
    expect(details).toHaveAttribute("aria-expanded", "true")
    expect(cells(dictionary())).toEqual([
      `20${key("partial")}`,
      "100%",
      `20${key("partial")}`,
      `5${key("partial")}`,
      "2",
    ])
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "requests" } })
    expect(cells(dictionary()).slice(0, 2)).toEqual(["2", "100%"])
    expect(screen.queryByText(key("partialShare"))).not.toBeInTheDocument()
  })

  it("selects a date with Enter, a named model with Space, and clears a hidden selected model", () => {
    const { history } = fixture()
    render(<HistoryDashboard history={history} locale="en" />)
    const dayButton = dateButtons().at(-1)!
    dayButton.focus()
    fireEvent.keyDown(dayButton, { key: "Enter" })
    expect(dayButton).toHaveAttribute("aria-pressed", "true")
    const modelButton = screen.getByRole("button", { name: /ChatGPT · gpt-6.1-sol:/ })
    modelButton.focus()
    fireEvent.keyDown(modelButton, { key: " " })
    expect(modelButton).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("heading", { name: /ChatGPT/ })).toBeInTheDocument()
    expect(cells(dictionary())[0]).toBe(`20${key("partial")}`)
    fireEvent.click(screen.getByRole("checkbox", { name: /ChatGPT/ }))
    expect(screen.getByRole("heading", { name: key("periodDetails") })).toBeInTheDocument()
    expect(cells(dictionary())[0]).toBe("1,000")
    hideApi()
    expect(screen.getByText(key("noVisible"))).toBeInTheDocument()
  })

  it("uses one chart Tab stop with arrow, Home and End focus navigation", () => {
    render(<HistoryDashboard history={fixture().history} locale="en" />)
    const buttons = dateButtons()
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    buttons.at(-1)!.focus()
    fireEvent.keyDown(buttons.at(-1)!, { key: "ArrowLeft" })
    expect(buttons.at(-2)).toHaveFocus()
    fireEvent.keyDown(buttons.at(-2)!, { key: "Home" })
    expect(buttons[0]).toHaveFocus()
    fireEvent.keyDown(buttons[0]!, { key: "End" })
    expect(buttons.at(-1)).toHaveFocus()
    expect(dateButtons().filter((button) => button.tabIndex === 0)).toHaveLength(1)
    expect(screen.getByRole("heading", { name: key("periodDetails") })).toBeInTheDocument()
  })

  it("keeps used unknown values and zero-denominator shares unavailable, including selected details", () => {
    const { history, day } = fixture()
    history.days[day]![subscription.id]!.dictionary = {
      ...emptyUsageMetrics(),
      requests: 3,
      results: 2,
    }
    render(<HistoryDashboard history={history} locale="en" />)
    hideApi()
    expect(cells(dictionary())).toEqual(["—", "—"])
    fireEvent.keyDown(dateButtons().at(-1)!, { key: " " })
    fireEvent.keyDown(screen.getByRole("button", { name: /ChatGPT.*:/ }), { key: " " })
    fireEvent.click(screen.getByRole("button", { name: key("details") }))
    expect(cells(dictionary())).toEqual(["—", "—", "—", "—", "3"])
    expect(screen.queryByText(key("empty"))).not.toBeInTheDocument()
  })

  it("preserves measured zero without inventing a zero percent or a positive bar", () => {
    const { history, day } = fixture()
    history.days[day]![subscription.id]!.dictionary = {
      ...emptyUsageMetrics(),
      requests: 1,
      results: 1,
      inputReports: 1,
    }
    render(<HistoryDashboard history={history} locale="en" />)
    hideApi()
    expect(cells(dictionary())).toEqual(["0", "—"])
    expect(dateButtons().at(-1)).toHaveAccessibleName(/metrics.inputTokens: 0/)
    expect(screen.getByRole("figure").querySelectorAll("[data-model]")).toHaveLength(0)
  })

  it("keeps result-only and request-only features, sorts ties deterministically and excludes unused rows", () => {
    const { history, day } = fixture()
    delete history.models[api.id]
    history.days[day] = {
      [subscription.id]: {
        dictionary: { ...emptyUsageMetrics(), results: 1, inputReports: 1 },
        sentenceAnalysis: { ...emptyUsageMetrics(), results: 1, inputReports: 1, inputTokens: 5 },
        selectionTranslation: {
          ...emptyUsageMetrics(),
          results: 1,
          inputReports: 1,
          inputTokens: 5,
        },
        languageDetection: { ...emptyUsageMetrics(), requests: 1 },
      },
    }
    render(<HistoryDashboard history={history} locale="en" />)
    expect(
      within(table())
        .getAllByRole("rowheader")
        .map((row) => row.textContent),
    ).toEqual([
      "options.apiUsage.features.selectionTranslation",
      "options.apiUsage.features.sentenceAnalysis",
      "options.apiUsage.features.dictionary",
      "options.apiUsage.features.languageDetection",
    ])
    expect(cells(dictionary())).toEqual(["0", "0%"])
    const unknown = within(table()).getByRole("row", { name: /features.languageDetection/ })
    expect(cells(unknown)).toEqual(["—", "—"])
    expect(screen.getAllByText(key("partialShare"))).not.toHaveLength(0)
  })

  it("does not turn missing dates into measured zero tokens or reinterpret the start timestamp", () => {
    const { history, day } = fixture()
    history.since = Date.now() + 86400000
    render(<HistoryDashboard history={history} locale="en" />)
    expect(dateButtons().at(-1)).toHaveAccessibleName(/metrics.inputTokens: 1,020/)
    customRange(offsetUsageDate(day, 1), offsetUsageDate(day, 2))
    expect(
      dateButtons().every((button) =>
        button.getAttribute("aria-label")?.includes(key("unreported")),
      ),
    ).toBe(true)
    expect(screen.getByLabelText("options.apiUsage.total")).toHaveTextContent("—")
    expect(screen.getByText(key("noUsage"))).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("does not fabricate earlier history and retains first-use and invalid-range states", () => {
    const { rerender } = render(<HistoryDashboard history={emptyApiUsageHistory()} locale="en" />)
    expect(screen.getByText(key("empty"))).toBeInTheDocument()
    const { history, day } = fixture()
    rerender(<HistoryDashboard history={history} locale="en" />)
    customRange(offsetUsageDate(day, -10), offsetUsageDate(day, -9))
    expect(screen.getByText(key("olderUnknown"))).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    customRange(offsetUsageDate(day, 1), day)
    expect(screen.getByRole("alert")).toHaveTextContent(key("invalidRange"))
  })

  it("provides 30-day presets and paginates 40-day charts without changing full-period totals or scale", () => {
    const { history, day } = fixture()
    const first = offsetUsageDate(day, -39)
    history.days[first] = {
      [subscription.id]: {
        dictionary: {
          ...emptyUsageMetrics(),
          requests: 1,
          results: 1,
          inputReports: 1,
          inputTokens: 2000,
        },
      },
    }
    render(<HistoryDashboard history={history} locale="en" />)
    fireEvent.click(screen.getByRole("button", { name: key("range30") }))
    expect(dateButtons()).toHaveLength(30)
    expect(screen.queryByRole("button", { name: key("next") })).not.toBeInTheDocument()
    customRange(first, day)
    expect(dateButtons()).toHaveLength(31)
    expect(cells(dictionary())[0]).toBe(`3,020${key("partial")}`)
    expect(within(screen.getByRole("figure")).getByText("2,000")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: key("next") }))
    expect(dateButtons()).toHaveLength(9)
    expect(cells(dictionary())[0]).toBe(`3,020${key("partial")}`)
    expect(within(screen.getByRole("figure")).getByText("2,000")).toBeInTheDocument()
  })

  it("keeps exact tiny segment height and supports pointer model selection", () => {
    const { history, day } = fixture()
    history.days[day]![subscription.id]!.dictionary = {
      ...emptyUsageMetrics(),
      results: 1,
      inputReports: 1,
      inputTokens: 1,
    }
    render(<HistoryDashboard history={history} locale="en" />)
    const segment = screen
      .getByRole("figure")
      .querySelector<HTMLElement>(`[data-model='${subscription.id}']`)!
    expect(segment.style.height).toBe(`${(1 / 1001) * 100}%`)
    expect(segment.style.minHeight).toBe("")
    fireEvent.click(segment)
    expect(screen.getByRole("heading", { name: /ChatGPT/ })).toBeInTheDocument()
    expect(cells(dictionary())[0]).toBe("1")
  })

  it("keeps whole-list model labels, colors and patterns stable across hiding and custom ranges", () => {
    const { history, day } = fixture()
    render(<HistoryDashboard history={history} locale="en" />)
    const style = () =>
      screen.getByRole("figure").querySelector<HTMLElement>(`[data-model='${subscription.id}']`)!
        .style
    const original = { color: style().backgroundColor, pattern: style().backgroundImage }
    hideApi()
    expect(style().backgroundColor).toBe(original.color)
    expect(style().backgroundImage).toBe(original.pattern)
    customRange(day, day)
    expect(style().backgroundColor).toBe(original.color)
    expect(style().backgroundImage).toBe(original.pattern)
    expect(screen.getByRole("checkbox", { name: /ChatGPT · gpt-6.1-sol/ })).toBeInTheDocument()
  })

  it("uses stable named connection/custom aliases without exposing hashes or transport jargon", () => {
    const { history, day } = fixture()
    const other = { ...api, id: "a".repeat(64), providerKey: "b".repeat(12) }
    const custom1 = { ...api, id: "c".repeat(64), model: null }
    const custom2 = { ...api, id: "d".repeat(64), model: null }
    history.models = {
      ...history.models,
      [other.id]: other,
      [custom1.id]: custom1,
      [custom2.id]: custom2,
    }
    history.days[offsetUsageDate(day, -1)] = {
      [api.id]: { dictionary: { ...emptyUsageMetrics(), requests: 1 } },
    }
    const labels = usageModelLabels(history)
    expect(labels[api.id]).toMatch(/connection 1$/)
    expect(labels[other.id]).toMatch(/connection 2$/)
    expect(labels[custom1.id]).toMatch(/privateModel 1$/)
    expect(labels[custom2.id]).toMatch(/privateModel 2$/)
    expect(historyModels(history).map((model, index) => modelPattern(index))).toHaveLength(5)
    render(<HistoryDashboard history={history} locale="en" />)
    const exposed = [
      document.body.textContent,
      ...[...document.querySelectorAll("[aria-label],[title]")].map(
        (element) => `${element.getAttribute("aria-label")} ${element.getAttribute("title")}`,
      ),
    ].join(" ")
    expect(exposed).not.toMatch(/BYOS|BYOK/)
    expect(exposed).not.toContain(api.providerKey.slice(0, 6))
    expect(exposed).not.toContain(subscription.id.slice(0, 6))
  })

  it.each(["deepl", "deeplx"] as const)(
    "labels model-less %s by service while keeping custom models distinct",
    (provider) => {
      const identity = createApiUsageIdentity({
        id: "synthetic-row",
        name: "synthetic",
        provider,
        enabled: true,
        apiKey: "synthetic-secret",
        baseURL: "https://synthetic.test",
      })
      expect(usageModelLabel(identity)).toBe(provider === "deepl" ? "DeepL" : "DeepLX")
      expect(usageModelLabel({ ...api, model: null })).toContain(key("privateModel"))
    },
  )
})
