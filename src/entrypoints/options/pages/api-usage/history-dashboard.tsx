import type { HistorySelection } from "./history-display"
import type { ApiUsageHistory, HistoryMetric, UsageMetrics } from "@/utils/api-usage-history"
import { useId, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import {
  Table,
  TableBody,
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
import { HistoryChart } from "./history-chart"
import {
  historyMetricValue,
  historyModels,
  modelPattern,
  usageModelLabels,
  usedMetrics,
} from "./history-display"

export function HistoryDashboard({
  history,
  locale,
}: {
  history: ApiUsageHistory
  locale: string
}) {
  const [metric, setMetric] = useState<HistoryMetric>("inputTokens")
  const [range, setRange] = useState<"7" | "30" | "custom">("7")
  const [from, setFrom] = useState(() => offsetUsageDate(localUsageDate(), -6))
  const [to, setTo] = useState(() => localUsageDate())
  const [page, setPage] = useState(0)
  const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<HistorySelection | null>(null)
  const [expanded, setExpanded] = useState(false)
  const detailMetrics = (["inputTokens", "outputTokens", "requests"] as const).filter(
    (value) => value !== metric,
  )
  const tableId = useId()
  const models = historyModels(history)
  const labels = usageModelLabels(history)
  const visible = models.filter((model) => visibility[model.id] ?? true)
  const visibleIds = visible.map((model) => model.id)
  const validSelection =
    selection &&
    (!selection.model || visibleIds.includes(selection.model)) &&
    selection.day >= from &&
    selection.day <= to
      ? selection
      : null
  const totals = historyFeatureTotals(
    history,
    validSelection?.day ?? from,
    validSelection?.day ?? to,
    validSelection?.model ? [validSelection.model] : visibleIds,
  )
  const rows = API_USAGE_FEATURES.map((feature, order) => ({
    feature,
    order,
    metrics: totals[feature],
    ...historyMetricValue(totals[feature], metric),
  }))
    .filter((row) => usedMetrics(row.metrics))
    .sort(
      (a, b) =>
        Number(b.known) - Number(a.known) ||
        b.value - a.value ||
        b.metrics.requests - a.metrics.requests ||
        a.order - b.order,
    )
  const summary = sumHistoryMetrics(
    Object.fromEntries(rows.map((row) => [row.feature, row.metrics])),
  )
  const denominator = rows.reduce((sum, row) => sum + (row.known ? row.value : 0), 0)
  const partialShare = rows.some((row) => !row.known || row.partial)
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
  // Saved civil-date keys stay authoritative after device timezone changes.
  const firstDay = Object.keys(history.days).sort()[0]
  const beforeHistory = firstDay !== undefined && to < firstDay
  const incompletePeriod = firstDay !== undefined && from < firstDay
  const number = (value: number) => value.toLocaleString(locale)
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 })
  const date = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
  const metricLabel = i18n.t(`options.apiUsage.history.metrics.${metric}`)
  const selectedLabel = validSelection
    ? `${date(validSelection.day)}${validSelection.model ? ` · ${labels[validSelection.model]}` : ""}`
    : i18n.t("options.apiUsage.history.periodDetails")
  const showValue = (metrics: UsageMetrics, valueMetric: HistoryMetric) => {
    const { known, value, partial } = historyMetricValue(metrics, valueMetric)
    return known && usedMetrics(metrics) ? (
      <>
        {number(value)}
        {partial && (
          <span className="ml-1 text-xs text-muted-foreground">
            {i18n.t("options.apiUsage.history.partial")}
          </span>
        )}
      </>
    ) : (
      <span role="img" aria-label={i18n.t("options.apiUsage.history.unreported")}>
        —
      </span>
    )
  }
  const setPreset = (preset: "7" | "30" | "custom") => {
    setRange(preset)
    setPage(0)
    setSelection(null)
    if (preset !== "custom") {
      const today = localUsageDate()
      setFrom(offsetUsageDate(today, preset === "7" ? -6 : -29))
      setTo(today)
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label={i18n.t("options.apiUsage.history.period")}
          className="inline-flex rounded-xl bg-muted p-1"
        >
          {(["7", "30", "custom"] as const).map((preset) => (
            <button
              type="button"
              key={preset}
              aria-pressed={range === preset}
              onClick={() => setPreset(preset)}
              className="min-h-9 rounded-lg px-3 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
            >
              {i18n.t(
                preset === "7"
                  ? "options.apiUsage.history.range7"
                  : preset === "30"
                    ? "options.apiUsage.history.range30"
                    : "options.apiUsage.history.rangeCustom",
              )}
            </button>
          ))}
        </div>
        <label>
          <span className="sr-only">{i18n.t("options.apiUsage.history.metric")}</span>
          <select
            value={metric}
            onChange={(event) => setMetric(event.target.value as HistoryMetric)}
            className="h-10 rounded-xl border bg-background px-3 text-sm"
          >
            {(["inputTokens", "outputTokens", "requests"] as const).map((value) => (
              <option key={value} value={value}>
                {i18n.t(`options.apiUsage.history.metrics.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {range === "custom" && (
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1 text-sm">
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
          <label className="space-y-1 text-sm">
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
        </div>
      )}
      {history.since === null ? (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          {i18n.t("options.apiUsage.history.empty")}
        </p>
      ) : (
        <>
          {length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {i18n.t("options.apiUsage.history.invalidRange")}
            </p>
          ) : beforeHistory ? (
            <p role="status" className="text-sm text-muted-foreground">
              {i18n.t("options.apiUsage.history.olderUnknown")}
            </p>
          ) : (
            <>
              {incompletePeriod && (
                <p role="status" className="text-xs text-muted-foreground">
                  {i18n.t("options.apiUsage.history.olderUnknown")}
                </p>
              )}
              <div className="space-y-7 rounded-2xl border bg-card p-5 text-card-foreground sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-muted-foreground">{metricLabel}</p>
                    <p
                      className="mt-1 text-3xl font-medium tabular-nums"
                      aria-label={i18n.t("options.apiUsage.total")}
                    >
                      {showValue(summary, metric)}
                    </p>
                    {partialShare && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {i18n.t("options.apiUsage.history.partialShare")}
                      </p>
                    )}
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    <p>
                      {validSelection ? date(validSelection.day) : `${date(from)} – ${date(to)}`}
                    </p>
                    {pageCount > 1 && (
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={currentPage === 0}
                          aria-label={i18n.t("options.apiUsage.history.previous")}
                          onClick={() => setPage((value) => value - 1)}
                        >
                          ←
                        </Button>
                        <span className="text-xs">
                          {date(days[0]!)} – {date(days.at(-1)!)}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={currentPage + 1 === pageCount}
                          aria-label={i18n.t("options.apiUsage.history.next")}
                          onClick={() => setPage((value) => value + 1)}
                        >
                          →
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                {visible.length === 0 ? (
                  <p role="status" className="py-10 text-sm text-muted-foreground">
                    {i18n.t("options.apiUsage.history.noVisible")}
                  </p>
                ) : (
                  <HistoryChart
                    history={history}
                    days={days}
                    models={visible}
                    allModels={models}
                    labels={labels}
                    metric={metric}
                    scaleMaximum={scaleMaximum}
                    locale={locale}
                    selection={validSelection}
                    onSelect={setSelection}
                  />
                )}
                <fieldset>
                  <legend className="sr-only">{i18n.t("options.apiUsage.history.legend")}</legend>
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    {models.map((model, index) => (
                      <label
                        key={model.id}
                        className="flex min-h-8 cursor-pointer items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={visibility[model.id] ?? true}
                          onChange={(event) => {
                            setVisibility((old) => ({ ...old, [model.id]: event.target.checked }))
                            if (!event.target.checked && selection?.model === model.id)
                              setSelection(null)
                          }}
                          className="accent-primary"
                        />
                        <span
                          aria-hidden="true"
                          className="h-3 w-3 rounded-sm"
                          style={modelPattern(index)}
                        />
                        {labels[model.id]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              {visible.length > 0 && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div role="status" aria-live="polite">
                      <h2 className="font-medium">{selectedLabel}</h2>
                    </div>
                    <div className="flex gap-2">
                      {validSelection && (
                        <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
                          {i18n.t("options.apiUsage.history.clearSelection")}
                        </Button>
                      )}
                      {rows.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-expanded={expanded}
                          aria-controls={tableId}
                          onClick={() => setExpanded((value) => !value)}
                        >
                          {i18n.t("options.apiUsage.history.details")}
                        </Button>
                      )}
                    </div>
                  </div>
                  {validSelection && (
                    <div
                      role="group"
                      aria-label={i18n.t("options.apiUsage.history.legend")}
                      className="flex flex-wrap gap-2"
                    >
                      {visible
                        .filter((model) => {
                          const features = history.days[validSelection.day]?.[model.id]
                          return features && usedMetrics(sumHistoryMetrics(features))
                        })
                        .map((model) => (
                          <button
                            type="button"
                            key={model.id}
                            aria-pressed={validSelection.model === model.id}
                            className="min-h-9 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted"
                            onClick={() =>
                              setSelection({ day: validSelection.day, model: model.id })
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault()
                                setSelection({ day: validSelection.day, model: model.id })
                              }
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className="mr-2 inline-block h-2.5 w-2.5 rounded-sm"
                              style={modelPattern(models.findIndex((item) => item.id === model.id))}
                            />
                            {labels[model.id]}:{" "}
                            {showValue(
                              sumHistoryMetrics(history.days[validSelection.day]![model.id]!),
                              metric,
                            )}
                          </button>
                        ))}
                    </div>
                  )}
                  {rows.length === 0 ? (
                    <p role="status" className="py-4 text-sm text-muted-foreground">
                      {i18n.t("options.apiUsage.history.noUsage")}
                    </p>
                  ) : (
                    <Table
                      id={tableId}
                      aria-label={i18n.t("options.apiUsage.history.detailsTitle")}
                    >
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">{i18n.t("options.apiUsage.feature")}</TableHead>
                          <TableHead scope="col" className="text-right">
                            {metricLabel}
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            {i18n.t("options.apiUsage.history.share")}
                            {partialShare && (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({i18n.t("options.apiUsage.history.partialShare")})
                              </span>
                            )}
                          </TableHead>
                          {expanded &&
                            detailMetrics.map((value) => (
                              <TableHead key={value} scope="col" className="text-right">
                                {i18n.t(`options.apiUsage.history.metrics.${value}`)}
                              </TableHead>
                            ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row) => {
                          const ratio =
                            denominator > 0 && row.known ? row.value / denominator : null
                          return (
                            <TableRow key={row.feature}>
                              <TableHead scope="row" className="font-normal">
                                {i18n.t(`options.apiUsage.features.${row.feature}`)}
                              </TableHead>
                              <TableCell className="text-right tabular-nums">
                                {showValue(row.metrics, metric)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {ratio === null ? (
                                  <span
                                    role="img"
                                    aria-label={i18n.t(
                                      row.known
                                        ? "options.apiUsage.history.noShare"
                                        : "options.apiUsage.history.unreported",
                                    )}
                                    title={i18n.t(
                                      row.known
                                        ? "options.apiUsage.history.noShare"
                                        : "options.apiUsage.history.unreported",
                                    )}
                                  >
                                    —
                                  </span>
                                ) : ratio > 0 && ratio < 0.001 ? (
                                  `<${percent.format(0.001)}`
                                ) : (
                                  percent.format(ratio)
                                )}
                              </TableCell>
                              {expanded &&
                                detailMetrics.map((value) => (
                                  <TableCell key={value} className="text-right tabular-nums">
                                    {showValue(row.metrics, value)}
                                  </TableCell>
                                ))}
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
