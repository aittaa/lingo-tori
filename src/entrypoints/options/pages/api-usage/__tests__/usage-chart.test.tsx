// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emptyApiUsage } from "@/utils/api-usage"
import { UsageChart } from "../usage-chart"

vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))
afterEach(cleanup)

describe("request comparison bars", () => {
  it("uses one zero-based scale and the same API/BYOS totals as the table", () => {
    const usage = emptyApiUsage()
    usage.since = 1000
    usage.counts.dictionary = { api: 15, byos: 5 }
    usage.counts.pageTranslation = { api: 10, byos: 0 }
    render(<UsageChart usage={usage} locale="en" snapshotAt={2000} />)
    const chart = screen.getByRole("figure", { name: "options.apiUsage.chart.title" })
    const rows = within(chart).getByRole("list", { name: "options.apiUsage.chart.axis" })
    const items = within(rows).getAllByRole("listitem")
    expect(items).toHaveLength(13)
    expect(items[0]).toHaveAccessibleName(/features.dictionary.*api 15.*byos 5.*total 20/)
    expect(items[1]).toHaveAccessibleName(/features.pageTranslation.*api 10.*byos 0.*total 10/)
    const largestBar = items[0]?.querySelector('[aria-hidden="true"]')
    const smallerBar = items[1]?.querySelector('[aria-hidden="true"]')
    expect(largestBar?.children[0]).toHaveStyle({ width: "75%" })
    expect(largestBar?.children[1]).toHaveStyle({ width: "25%" })
    expect(smallerBar?.children[0]).toHaveStyle({ width: "50%" })
    expect(smallerBar?.children[1]).toHaveStyle({ width: "0%" })
    expect(
      within(chart).getByText("options.apiUsage.chart.period:", { exact: false }),
    ).toHaveTextContent(new Date(2000).toLocaleString("en"))
    expect(within(chart).getByText("options.apiUsage.chart.byosLegend")).toBeInTheDocument()
  })

  it("keeps a first-use chart empty instead of inventing a period or nonzero bars", () => {
    render(<UsageChart usage={emptyApiUsage()} locale="en" snapshotAt={2000} />)
    const chart = screen.getByRole("figure", { name: "options.apiUsage.chart.title" })
    expect(within(chart).getByText("options.apiUsage.empty")).toBeInTheDocument()
    expect(
      within(chart).queryByRole("list", { name: "options.apiUsage.chart.axis" }),
    ).not.toBeInTheDocument()
    expect(
      within(chart).queryByText("options.apiUsage.chart.period:", { exact: false }),
    ).not.toBeInTheDocument()
  })
})
