import { useQuery } from "@tanstack/react-query"
import i18next from "i18next"
import { useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/base-ui/table"
import { API_USAGE_FEATURES } from "@/utils/api-usage"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { PageLayout } from "../../components/page-layout"
import { HistoryDashboard } from "./history-dashboard"
import { UsageChart } from "./usage-chart"

export function ApiUsagePage() {
  const {
    data: snapshot,
    dataUpdatedAt,
    isFetching: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["apiUsage"],
    queryFn: () => sendMessage("getApiUsage", undefined),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const [view, setView] = useState<"history" | "lifetime">("history")
  const effectiveView = snapshot?.history === undefined ? "lifetime" : view
  const history = isError ? null : snapshot?.history
  const currentValue = effectiveView === "history" ? history : isError ? null : snapshot?.usage
  const locale = i18next.resolvedLanguage ?? i18next.language ?? "en"
  const usage = isError ? null : snapshot?.usage
  const totals = API_USAGE_FEATURES.reduce(
    (total, feature) => ({
      api: total.api + (usage?.counts[feature].api ?? 0),
      byos: total.byos + (usage?.counts[feature].byos ?? 0),
    }),
    { api: 0, byos: 0 },
  )

  return (
    <PageLayout title={i18n.t("options.apiUsage.title")} innerClassName="space-y-6">
      <section id="api-usage" className="space-y-4" aria-busy={loading}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            className="flex flex-wrap gap-2"
            aria-label={i18n.t("options.apiUsage.history.views")}
          >
            <Button
              variant={effectiveView === "history" ? "default" : "outline"}
              aria-pressed={effectiveView === "history"}
              onClick={() => setView("history")}
              disabled={snapshot?.history === undefined}
            >
              {i18n.t("options.apiUsage.history.viewHistory")}
            </Button>
            <Button
              variant={effectiveView === "lifetime" ? "default" : "outline"}
              aria-pressed={effectiveView === "lifetime"}
              onClick={() => setView("lifetime")}
            >
              {i18n.t("options.apiUsage.history.viewLifetime")}
            </Button>
          </div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              void refetch()
            }}
          >
            {i18n.t("options.apiUsage.refresh")}
          </Button>
        </div>
        {effectiveView === "lifetime" && usage && (
          <p className="text-sm text-muted-foreground">
            {usage.since !== null
              ? `${i18n.t("options.apiUsage.since")}: ${new Date(usage.since).toLocaleDateString(locale)}`
              : i18n.t("options.apiUsage.empty")}
          </p>
        )}
        <div role="status" aria-live="polite">
          {loading && (
            <p className="text-sm text-muted-foreground">{i18n.t("options.apiUsage.loading")}</p>
          )}
          {!loading && !currentValue && (
            <p className="text-sm text-destructive">{i18n.t("options.apiUsage.unavailable")}</p>
          )}
          {currentValue &&
            (effectiveView === "history" ? snapshot?.historyIncomplete : snapshot?.incomplete) && (
              <p className="text-sm text-destructive">{i18n.t("options.apiUsage.incomplete")}</p>
            )}
        </div>
        {effectiveView === "history" && history && (
          <HistoryDashboard history={history} locale={locale} />
        )}
        {effectiveView === "lifetime" && usage && (
          <UsageChart usage={usage} locale={locale} snapshotAt={dataUpdatedAt} />
        )}
        {effectiveView === "lifetime" && usage && (
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
            <Table aria-label={i18n.t("options.apiUsage.title")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{i18n.t("options.apiUsage.feature")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {i18n.t("options.apiUsage.api")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {i18n.t("options.apiUsage.byos")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {i18n.t("options.apiUsage.total")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {API_USAGE_FEATURES.map((feature) => (
                  <TableRow key={feature}>
                    <TableHead scope="row" className="font-normal">
                      {i18n.t(`options.apiUsage.features.${feature}`)}
                    </TableHead>
                    <TableCell className="text-right tabular-nums">
                      {usage.counts[feature].api.toLocaleString(locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usage.counts[feature].byos.toLocaleString(locale)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(usage.counts[feature].api + usage.counts[feature].byos).toLocaleString(
                        locale,
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableHead scope="row">{i18n.t("options.apiUsage.total")}</TableHead>
                  <TableCell className="text-right tabular-nums">
                    {totals.api.toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {totals.byos.toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(totals.api + totals.byos).toLocaleString(locale)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </section>
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded py-2 focus-visible:outline-2 focus-visible:outline-ring">
          {i18n.t("options.apiUsage.history.about")}
        </summary>
        <div className="mt-2 max-w-2xl space-y-2 leading-relaxed">
          <p>{i18n.t("options.apiUsage.semantics")}</p>
          <p>{i18n.t("options.apiUsage.billing")}</p>
          <p>{i18n.t("options.apiUsage.history.dateRule")}</p>
          <p>{i18n.t("options.apiUsage.limitations")}</p>
        </div>
      </details>
    </PageLayout>
  )
}
