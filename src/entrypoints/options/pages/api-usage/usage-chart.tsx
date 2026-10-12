import type { ApiUsage } from "@/utils/api-usage"
import { useId } from "react"
import { API_USAGE_FEATURES } from "@/utils/api-usage"
import { i18n } from "@/utils/i18n"

const byosPattern = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent, transparent 3px, var(--background) 3px, var(--background) 5px)",
}

/** The same measured attempts as the table; no retry/cache series or chart dependency. */
export function UsageChart({
  usage,
  locale,
  snapshotAt,
}: {
  usage: ApiUsage
  locale: string
  snapshotAt: number
}) {
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`
  const rows = API_USAGE_FEATURES.map((feature) => ({
    feature,
    ...usage.counts[feature],
    total: usage.counts[feature].api + usage.counts[feature].byos,
  })).sort((a, b) => b.total - a.total)
  const maximum = Math.max(0, ...rows.map((row) => row.total))
  const format = (count: number) => count.toLocaleString(locale)
  const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString(locale)

  return (
    <figure
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground"
    >
      <figcaption id={titleId} className="font-medium">
        {i18n.t("options.apiUsage.chart.title")}
      </figcaption>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {i18n.t("options.apiUsage.chart.description")}
      </p>
      {usage.since !== null && (
        <p className="text-sm text-muted-foreground">
          {i18n.t("options.apiUsage.chart.period")}: {formatTime(usage.since)} –{" "}
          {formatTime(snapshotAt)}
        </p>
      )}
      <ul
        className="flex flex-wrap gap-x-5 gap-y-2 text-sm"
        aria-label={i18n.t("options.apiUsage.chart.legend")}
      >
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="h-3 w-5 rounded-sm bg-primary" />
          {i18n.t("options.apiUsage.api")}
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="h-3 w-5 rounded-sm bg-primary" style={byosPattern} />
          {i18n.t("options.apiUsage.chart.byosLegend")}
        </li>
      </ul>
      {maximum === 0 ? (
        <p className="text-sm text-muted-foreground">{i18n.t("options.apiUsage.empty")}</p>
      ) : (
        <>
          <div aria-hidden="true" className="space-y-1 text-xs text-muted-foreground">
            <p>{i18n.t("options.apiUsage.chart.axis")}</p>
            <div className="flex justify-between border-b pb-1 tabular-nums">
              <span>{format(0)}</span>
              <span>{format(maximum)}</span>
            </div>
          </div>
          <ol className="space-y-3" aria-label={i18n.t("options.apiUsage.chart.axis")}>
            {rows.map(({ feature, api, byos, total }) => {
              const label = i18n.t(`options.apiUsage.features.${feature}`)
              return (
                <li
                  key={feature}
                  aria-label={`${label}: ${i18n.t("options.apiUsage.api")} ${format(api)}, ${i18n.t("options.apiUsage.byos")} ${format(byos)}, ${i18n.t("options.apiUsage.total")} ${format(total)}`}
                >
                  <div className="mb-1 flex items-start justify-between gap-4 text-sm">
                    <span>{label}</span>
                    <span className="shrink-0 tabular-nums">{format(total)}</span>
                  </div>
                  <div aria-hidden="true" className="flex h-3 overflow-hidden rounded-sm bg-muted">
                    <span
                      className="h-full bg-primary"
                      style={{ width: `${(api / maximum) * 100}%` }}
                    />
                    <span
                      className="h-full bg-primary"
                      style={{ ...byosPattern, width: `${(byos / maximum) * 100}%` }}
                    />
                  </div>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </figure>
  )
}
