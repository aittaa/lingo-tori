import type { KeyboardEvent } from "react"
import type { HistorySelection } from "./history-display"
import type { ApiUsageHistory, HistoryMetric } from "@/utils/api-usage-history"
import type { ApiUsageIdentity } from "@/utils/api-usage-identity"
import { useId, useRef, useState } from "react"
import { sumHistoryMetrics } from "@/utils/api-usage-history"
import { i18n } from "@/utils/i18n"
import { historyMetricValue, modelPattern, usedMetrics } from "./history-display"

export function HistoryChart({
  history,
  days,
  models,
  allModels,
  labels,
  metric,
  scaleMaximum,
  locale,
  selection,
  onSelect,
}: {
  history: ApiUsageHistory
  days: string[]
  models: ApiUsageIdentity[]
  allModels: ApiUsageIdentity[]
  labels: Record<string, string>
  metric: HistoryMetric
  scaleMaximum: number
  locale: string
  selection: HistorySelection | null
  onSelect: (selection: HistorySelection) => void
}) {
  const id = useId()
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [focusedDay, setFocusedDay] = useState<string | null>(null)
  const tabDay = days.includes(focusedDay ?? "")
    ? focusedDay
    : days.includes(selection?.day ?? "")
      ? selection?.day
      : days.at(-1)
  const format = (value: number) => value.toLocaleString(locale)
  const date = (day: string, full = false) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(full ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    })
  const metricLabel = i18n.t(`options.apiUsage.history.metrics.${metric}`)
  const firstDay = Object.keys(history.days).sort()[0]
  const keySelect = (event: KeyboardEvent<HTMLButtonElement>, day: string, index: number) => {
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: days.length - 1 }[
      event.key
    ]
    if (next !== undefined) {
      event.preventDefault()
      const target = days[Math.max(0, Math.min(days.length - 1, next))]!
      setFocusedDay(target)
      refs.current[target]?.focus()
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelect({ day })
    }
  }
  return (
    <figure aria-labelledby={`${id}-title`} className="space-y-2">
      <figcaption id={`${id}-title`} className="sr-only">
        {metricLabel} · {days[0]} – {days.at(-1)}
      </figcaption>
      <div className="flex gap-3">
        <div
          aria-hidden="true"
          className="flex w-14 shrink-0 flex-col justify-between pb-6 text-right text-xs text-muted-foreground tabular-nums"
        >
          <span>{format(scaleMaximum)}</span>
          <span>{format(0)}</span>
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ minWidth: `${days.length * (days.length <= 10 ? 42 : 18)}px` }}>
            <div className="relative h-56 border-b border-muted-foreground/30">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex flex-col justify-between"
              >
                <span className="border-t border-dashed border-muted-foreground/15" />
                <span className="border-t border-dashed border-muted-foreground/15" />
                <span />
              </div>
              <div
                className="relative grid h-full gap-0.5"
                style={{ gridTemplateColumns: `repeat(${days.length}, minmax(14px, 1fr))` }}
              >
                {days.map((day, index) => {
                  const segments = models.flatMap((model) => {
                    const features = history.days[day]?.[model.id]
                    if (!features) return []
                    const metrics = sumHistoryMetrics(features)
                    if (!usedMetrics(metrics)) return []
                    return [{ model, ...historyMetricValue(metrics, metric) }]
                  })
                  const known = segments.some((segment) => segment.known)
                  const partial = segments.some((segment) => !segment.known || segment.partial)
                  const total = segments.reduce(
                    (sum, segment) => sum + (segment.known ? segment.value : 0),
                    0,
                  )
                  const value = known
                    ? `${metricLabel}: ${format(total)}${partial ? ` (${i18n.t("options.apiUsage.history.partial")})` : ""}`
                    : i18n.t(
                        firstDay && day < firstDay
                          ? "options.apiUsage.history.beforeHistory"
                          : "options.apiUsage.history.unreported",
                      )
                  return (
                    <button
                      type="button"
                      key={day}
                      ref={(element) => {
                        refs.current[day] = element
                      }}
                      tabIndex={tabDay === day ? 0 : -1}
                      aria-pressed={selection?.day === day}
                      aria-label={`${date(day, true)}, ${value}`}
                      title={[
                        `${date(day, true)}, ${value}`,
                        ...segments.map(
                          (segment) =>
                            `${labels[segment.model.id]}: ${segment.known ? format(segment.value) : i18n.t("options.apiUsage.history.unreported")}`,
                        ),
                      ].join("\n")}
                      className="relative flex h-full flex-col-reverse overflow-hidden rounded-t-sm outline-offset-2 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted/40"
                      onFocus={() => setFocusedDay(day)}
                      onClick={(event) => {
                        const model =
                          event.target instanceof Element
                            ? event.target.closest<HTMLElement>("[data-model]")?.dataset.model
                            : undefined
                        onSelect(model ? { day, model } : { day })
                      }}
                      onKeyDown={(event) => keySelect(event, day, index)}
                    >
                      {segments
                        .filter((segment) => segment.known && segment.value > 0)
                        .map(({ model, value: segmentValue }) => (
                          <span
                            key={model.id}
                            data-model={model.id}
                            aria-hidden="true"
                            className="block w-full shrink-0"
                            style={{
                              ...modelPattern(allModels.findIndex((item) => item.id === model.id)),
                              height: `${(segmentValue / scaleMaximum) * 100}%`,
                            }}
                          />
                        ))}
                      {segments.length > 0 && !known && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-x-0 bottom-1 text-center text-xs text-muted-foreground"
                        >
                          —
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            <div
              aria-hidden="true"
              className="mt-2 grid text-center text-xs text-muted-foreground"
              style={{ gridTemplateColumns: `repeat(${days.length}, minmax(14px, 1fr))` }}
            >
              {days.map((day, index) => (
                <span key={day}>
                  {days.length <= 10 ||
                  (index % 7 === 0 && index < days.length - 3) ||
                  index === days.length - 1
                    ? date(day)
                    : ""}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </figure>
  )
}
