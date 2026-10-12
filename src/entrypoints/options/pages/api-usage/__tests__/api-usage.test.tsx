// @vitest-environment jsdom
import type { ApiUsageSnapshot } from "@/utils/api-usage"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emptyApiUsage } from "@/utils/api-usage"
import { ApiUsagePage } from ".."

const { readUsage } = vi.hoisted(() => ({ readUsage: vi.fn<() => Promise<ApiUsageSnapshot>>() }))
vi.mock("@/utils/message", () => ({ sendMessage: readUsage }))
vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))

afterEach(cleanup)
beforeEach(() => {
  readUsage.mockReset()
})
function showPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <ApiUsagePage />
    </QueryClientProvider>,
  )
}

describe("API usage settings", () => {
  it("shows separate API/BYOS counts and refreshes persisted totals", async () => {
    const usage = emptyApiUsage()
    usage.since = 1234
    usage.counts.dictionary = { api: 12, byos: 3 }
    readUsage.mockResolvedValueOnce({ usage, incomplete: false })
    showPage()
    const row = await screen.findByRole("row", {
      name: "options.apiUsage.features.dictionary 12 3",
    })
    expect(within(row).getByRole("rowheader")).toBeInTheDocument()
    expect(screen.getByText("options.apiUsage.billing")).toBeInTheDocument()
    expect(screen.queryByText("Translation Hub")).not.toBeInTheDocument()
    const updated = structuredClone(usage)
    updated.counts.dictionary.api = 13
    readUsage.mockResolvedValueOnce({ usage: updated, incomplete: false })
    fireEvent.click(screen.getByRole("button", { name: "options.apiUsage.refresh" }))
    expect(
      await screen.findByRole("row", { name: "options.apiUsage.features.dictionary 13 3" }),
    ).toBeInTheDocument()
  })

  it("reports unavailable storage as unknown rather than displaying a zero table", async () => {
    readUsage.mockResolvedValue({ usage: null, incomplete: true })
    showPage()
    expect(await screen.findByText("options.apiUsage.unavailable")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.queryByText("options.apiUsage.empty")).not.toBeInTheDocument()
  })

  it("distinguishes first-use emptiness from incomplete saved counts", async () => {
    readUsage.mockResolvedValue({ usage: emptyApiUsage(), incomplete: true })
    showPage()
    expect(await screen.findByText("options.apiUsage.empty")).toBeInTheDocument()
    expect(screen.getByText("options.apiUsage.incomplete")).toBeInTheDocument()
    expect(screen.getByRole("table")).toBeInTheDocument()
  })
})
