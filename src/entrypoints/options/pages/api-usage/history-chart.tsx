import type { KeyboardEvent } from "react"
import type { ApiUsageHistory, HistoryMetric, UsageMetrics } from "@/utils/api-usage-history"
import type { ApiUsageIdentity } from "@/utils/api-usage-identity"
import { useId } from "react"
import { sumHistoryMetrics } from "@/utils/api-usage-history"
import { i18n } from "@/utils/i18n"

export interface HistorySelection {
  day: string
  model: string
}
export function usageModelLabel(identity: ApiUsageIdentity): string {
  const provider =
    identity.transport === "byos"
      ? "ChatGPT / BYOS"
      : `${identity.provider} / API (${identity.providerKey.slice(0, 6)})`
  if (identity.model === null && ["deepl", "deeplx"].includes(identity.provider)) return provider
  const model =
    identity.model ??
    `${i18n.t("options.apiUsage.history.privateModel")} ${identity.id.slice(0, 6)}`
  return `${provider} · ${model}`
}
export function historyMetricValue(metrics: UsageMetrics, metric: HistoryMetric) {
  return {
    value: metrics[metric],
    known:
      metric === "requests" ||
      metrics[metric === "inputTokens" ? "inputReports" : "outputReports"] > 0,
  }
}
export function modelPattern(index: number) {
  return {
    backgroundImage: `repeating-linear-gradient(${index % 2 === 0 ? 45 : 135}deg, transparent, transparent ${3 + (index % 3)}px, var(--background) ${3 + (index % 3)}px, var(--background) ${4 + (index % 3)}px)`,
  }
}

/** Native buttons select every plotted or unreported model segment with Enter/Space. */
export function HistoryChart({
  history,
  days,
  models,
  metric,
  scaleMaximum,
  locale,
  selection,
  onSelect,
}: {
  history: ApiUsageHistory
  days: string[]
  models: ApiUsageIdentity[]
  metric: HistoryMetric
  scaleMaximum: number
  locale: string
  selection: HistorySelection | null
  onSelect: (selection: HistorySelection) => void
}) {
  const keySelect = (event: KeyboardEvent<HTMLButtonElement>, day: string, model: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelect({ day, model })
    }
  }
  const id = useId()
  const columns = days.map((day) => ({
    day,
    segments: models.flatMap((model, index) => {
      const features = history.days[day]?.[model.id]
      if (!features) return []
      const metrics = sumHistoryMetrics(features)
      return [{ model, index, metrics, ...historyMetricValue(metrics, metric) }]
    }),
  }))
  const max = scaleMaximum
  const firstDay = Object.keys(history.days).sort()[0]
  const format = (value: number) => value.toLocaleString(locale)
  const metricLabel = i18n.t(`options.apiUsage.history.metrics.${metric}`)
  return (
    <figure
      className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
    >
      <figcaption id={`${id}-title`} className="font-medium">
        {i18n.t("options.apiUsage.history.chartTitle")}
      </figcaption>
      <p id={`${id}-description`} className="text-sm text-muted-foreground">
        {i18n.t("options.apiUsage.history.chartDescription")}
      </p>
      <p className="text-sm text-muted-foreground">
        {days[0]} – {days.at(-1)}
      </p>
      <p className="text-sm text-muted-foreground">
        {metricLabel} · {i18n.t("options.apiUsage.history.visibleTotals")}
      </p>
      <div className="flex gap-3">
        <div
          aria-hidden="true"
          className="flex w-12 shrink-0 flex-col justify-between pb-16 text-right text-xs text-muted-foreground tabular-nums"
        >
          <span>{format(max)}</span>
          <span>{format(0)}</span>
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div
            className="flex items-start gap-3 border-b pb-3"
            style={{ minWidth: `${days.length * 72}px` }}
          >
            {columns.map(({ day, segments }) => {
              const known = segments.some((segment) => segment.known)
              const sum = segments.reduce(
                (total, segment) => total + (segment.known ? segment.value : 0),
                0,
              )
              const select = (model: string) => onSelect({ day, model })
              return (
                <div key={day} className="w-15 shrink-0 space-y-2 text-center">
                  <p className="text-xs tabular-nums">{known ? format(sum) : "—"}</p>
                  <div
                    className="flex h-52 flex-col-reverse border-b border-l bg-muted/30"
                    aria-label={`${day}, ${metricLabel}`}
                  >
                    {segments
                      .filter((segment) => segment.known && segment.value > 0)
                      .map(({ model, index, value, metrics }) => (
                        <button
                          type="button"
                          key={model.id}
                          className="w-full shrink-0 overflow-hidden bg-primary text-primary-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                          style={{ ...modelPattern(index), height: `${(value / max) * 100}%` }}
                          aria-pressed={selection?.day === day && selection.model === model.id}
                          aria-label={`${day}, ${usageModelLabel(model)}, ${metricLabel}: ${format(value)}, ${i18n.t("options.apiUsage.history.requests")}: ${format(metrics.requests)}`}
                          title={`${usageModelLabel(model)}: ${format(value)}`}
                          onClick={() => select(model.id)}
                          onKeyDown={(event) => keySelect(event, day, model.id)}
                        >
                          <span aria-hidden="true" className="text-[10px] leading-none">
                            {index + 1}
                          </span>
                        </button>
                      ))}
                  </div>
                  <p className="text-xs">
                    {new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </p>
                  <div className="flex flex-wrap justify-center gap-1">
                    {segments.map(({ model, index, known: available, value }) => (
                      <button
                        type="button"
                        key={model.id}
                        className="min-h-6 rounded border px-1 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                        aria-pressed={selection?.day === day && selection.model === model.id}
                        aria-label={`${i18n.t("options.apiUsage.history.selectDetails")}: ${day}, ${usageModelLabel(model)}, ${available ? `${metricLabel}: ${format(value)}` : i18n.t("options.apiUsage.history.unreported")}`}
                        onClick={() => select(model.id)}
                        onKeyDown={(event) => keySelect(event, day, model.id)}
                      >
                        {index + 1}: {available ? format(value) : "—"}
                      </button>
                    ))}
                    {segments.length === 0 && (
                      <span className="text-xs text-muted-foreground">
                        {firstDay && day < firstDay
                          ? i18n.t("options.apiUsage.history.beforeHistory")
                          : i18n.t("options.apiUsage.history.noReports")}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{i18n.t("options.apiUsage.history.dateAxis")}</p>
    </figure>
  )
}
