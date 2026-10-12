import type { HistorySelection } from "./history-chart"
import type { ApiUsageHistory, HistoryMetric } from "@/utils/api-usage-history"
import { useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/base-ui/table"
import { API_USAGE_FEATURES } from "@/utils/api-usage"
import {
  historyFeatureTotals,
  sumHistoryMetrics,
  localUsageDate,
  offsetUsageDate,
  usageRangeDays,
  usageRangeLength,
} from "@/utils/api-usage-history"
import { i18n } from "@/utils/i18n"
import { HistoryChart, historyMetricValue, modelPattern, usageModelLabel } from "./history-chart"

export function HistoryDashboard({
  history,
  locale,
}: {
  history: ApiUsageHistory
  locale: string
}) {
  const [metric, setMetric] = useState<HistoryMetric>("inputTokens")
  const [from, setFrom] = useState(() => offsetUsageDate(localUsageDate(), -6))
  const [to, setTo] = useState(() => localUsageDate())
  const [page, setPage] = useState(0)
  const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<HistorySelection | null>(null)
  const models = Object.values(history.models).sort((a, b) =>
    a.transport === b.transport ? a.id.localeCompare(b.id) : a.transport === "byos" ? -1 : 1,
  )
  const visible = models.filter((model) => visibility[model.id] ?? model.transport === "byos")
  const visibleIds = visible.map((model) => model.id)
  const validSelection =
    selection &&
    visibleIds.includes(selection.model) &&
    selection.day >= from &&
    selection.day <= to
      ? selection
      : null
  const scaleMaximum = Object.entries(history.days).reduce((max, [day, dayModels]) => {
    if (day < from || day > to) return max
    const total = visible.reduce((sum, model) => {
      const features = dayModels[model.id]
      if (!features) return sum
      const value = historyMetricValue(sumHistoryMetrics(features), metric)
      return sum + (value.known ? value.value : 0)
    }, 0)
    return Math.max(max, total)
  }, 1)
  const length = usageRangeLength(from, to)
  const pageCount = Math.ceil(length / 31)
  const currentPage = Math.min(page, Math.max(0, pageCount - 1))
  const days = usageRangeDays(from, to, currentPage * 31)
  const totals = historyFeatureTotals(history, from, to, visibleIds, validSelection)
  const firstDay = Object.keys(history.days).sort()[0]
  const beforeHistory = firstDay !== undefined && to < firstDay
  const incompletePeriod = firstDay !== undefined && from < firstDay
  const numeric = (count: number) => count.toLocaleString(locale)
  const selectedLabel = validSelection
    ? `${validSelection.day} · ${usageModelLabel(history.models[validSelection.model]!)}`
    : i18n.t("options.apiUsage.history.periodDetails")
  const tokenValue = (value: number, reports: number, results: number) =>
    reports > 0
      ? `${numeric(value)}${reports < results ? ` (${i18n.t("options.apiUsage.history.partial")})` : ""}`
      : i18n.t("options.apiUsage.history.unreported")

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {i18n.t("options.apiUsage.history.byosPriority")}
      </p>
      <div className="flex flex-wrap items-end gap-4 rounded-xl border p-4">
        <label className="space-y-2 text-sm">
          <span className="block">{i18n.t("options.apiUsage.history.from")}</span>
          <Input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value)
              setPage(0)
              setSelection(null)
            }}
          />
        </label>
        <label className="space-y-2 text-sm">
          <span className="block">{i18n.t("options.apiUsage.history.to")}</span>
          <Input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value)
              setPage(0)
              setSelection(null)
            }}
          />
        </label>
        <label className="space-y-2 text-sm">
          <span className="block">{i18n.t("options.apiUsage.history.metric")}</span>
          <select
            className="h-9 rounded-lg border bg-background px-3"
            value={metric}
            onChange={(event) => setMetric(event.target.value as HistoryMetric)}
          >
            {(["inputTokens", "outputTokens", "requests"] as const).map((value) => (
              <option key={value} value={value}>
                {i18n.t(`options.apiUsage.history.metrics.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-sm text-muted-foreground">
        {i18n.t("options.apiUsage.history.period")}: {from} – {to}
      </p>
      {history.since !== null && (
        <p className="text-sm text-muted-foreground">
          {i18n.t("options.apiUsage.history.started")}:{" "}
          {new Date(history.since).toLocaleString(locale)}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{i18n.t("options.apiUsage.history.dateRule")}</p>
      {history.since === null ? (
        <p role="status" className="text-sm">
          {i18n.t("options.apiUsage.history.empty")}
        </p>
      ) : (
        <>
          <fieldset className="space-y-3 rounded-xl border p-4">
            <legend className="px-1 text-sm font-medium">
              {i18n.t("options.apiUsage.history.legend")}
            </legend>
            <p className="text-sm text-muted-foreground">
              {i18n.t("options.apiUsage.history.visibleTotals")}
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {models.map((model) => {
                const index = visible.findIndex((item) => item.id === model.id)
                return (
                  <label key={model.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={visibility[model.id] ?? model.transport === "byos"}
                      style={{ accentColor: "var(--primary)" }}
                      onChange={(event) => {
                        setVisibility((old) => ({ ...old, [model.id]: event.target.checked }))
                        if (!event.target.checked && selection?.model === model.id)
                          setSelection(null)
                      }}
                    />
                    <span
                      aria-hidden="true"
                      className="h-3 w-4 bg-primary"
                      style={modelPattern(Math.max(0, index))}
                    />
                    {index >= 0 ? `${index + 1}. ` : ""}
                    {usageModelLabel(model)}
                  </label>
                )
              })}
            </div>
          </fieldset>
          {length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {i18n.t("options.apiUsage.history.invalidRange")}
            </p>
          ) : visible.length === 0 ? (
            <p role="status" className="text-sm">
              {i18n.t("options.apiUsage.history.noVisible")}
            </p>
          ) : beforeHistory ? (
            <p role="status" className="text-sm text-muted-foreground">
              {i18n.t("options.apiUsage.history.olderUnknown")}
            </p>
          ) : (
            <>
              {incompletePeriod && (
                <p role="status" className="text-sm text-muted-foreground">
                  {i18n.t("options.apiUsage.history.olderUnknown")}
                </p>
              )}
              <HistoryChart
                history={history}
                days={days}
                models={visible}
                metric={metric}
                scaleMaximum={scaleMaximum}
                locale={locale}
                selection={validSelection}
                onSelect={setSelection}
              />
              {pageCount > 1 && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={currentPage === 0}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    {i18n.t("options.apiUsage.history.previous")}
                  </Button>
                  <span className="text-sm tabular-nums">
                    {currentPage + 1} / {pageCount} · {i18n.t("options.apiUsage.history.pageNote")}
                  </span>
                  <Button
                    variant="outline"
                    disabled={currentPage + 1 === pageCount}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    {i18n.t("options.apiUsage.history.next")}
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div role="status" aria-live="polite">
                  <h2 className="font-medium">{selectedLabel}</h2>
                </div>
                {validSelection && (
                  <Button variant="outline" onClick={() => setSelection(null)}>
                    {i18n.t("options.apiUsage.history.clearSelection")}
                  </Button>
                )}
              </div>
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table aria-label={i18n.t("options.apiUsage.history.detailsTitle")}>
                  <TableCaption>{i18n.t("options.apiUsage.history.tableCaption")}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{i18n.t("options.apiUsage.feature")}</TableHead>
                      <TableHead scope="col" className="text-right">
                        {i18n.t("options.apiUsage.history.metrics.inputTokens")}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {i18n.t("options.apiUsage.history.metrics.outputTokens")}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {i18n.t("options.apiUsage.history.requests")}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {i18n.t("options.apiUsage.history.coverage")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {API_USAGE_FEATURES.map((feature) => {
                      const values = totals[feature]
                      return (
                        <TableRow key={feature}>
                          <TableHead scope="row" className="font-normal">
                            {i18n.t(`options.apiUsage.features.${feature}`)}
                          </TableHead>
                          <TableCell className="text-right tabular-nums">
                            {tokenValue(values.inputTokens, values.inputReports, values.results)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {tokenValue(values.outputTokens, values.outputReports, values.results)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {numeric(values.requests)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {values.results > 0
                              ? `${numeric(values.inputReports)}/${numeric(values.results)} · ${numeric(values.outputReports)}/${numeric(values.results)}`
                              : i18n.t("options.apiUsage.history.unreported")}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>{i18n.t("options.apiUsage.history.coverageNote")}</p>
        <p>{i18n.t("options.apiUsage.history.tokenNote")}</p>
        <p>{i18n.t("options.apiUsage.history.identityNote")}</p>
      </div>
    </div>
  )
}
