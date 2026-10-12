import type { ApiUsageHistory, HistoryMetric, UsageMetrics } from "@/utils/api-usage-history"
import type { ApiUsageIdentity } from "@/utils/api-usage-identity"
import { PROVIDER_ITEMS } from "@/utils/constants/providers"
import { i18n } from "@/utils/i18n"

export interface HistorySelection {
  day: string
  model?: string
}
const modelLess = (model: ApiUsageIdentity) => ["deepl", "deeplx"].includes(model.provider)
export function usageModelLabel(model: ApiUsageIdentity): string {
  const service = PROVIDER_ITEMS[model.provider].name
  return modelLess(model)
    ? service
    : `${service} · ${model.model ?? i18n.t("options.apiUsage.history.privateModel")}`
}

/** Labels and styles use the complete saved model list, never the current filter. */
export function historyModels(history: ApiUsageHistory): ApiUsageIdentity[] {
  const firstSeen: Record<string, string> = {}
  for (const day of Object.keys(history.days).sort())
    for (const id of Object.keys(history.days[day]!)) firstSeen[id] ??= day
  return Object.values(history.models).sort(
    (a, b) =>
      (firstSeen[a.id] ?? "9999-12-31").localeCompare(firstSeen[b.id] ?? "9999-12-31") ||
      a.id.localeCompare(b.id),
  )
}
export function usageModelLabels(history: ApiUsageHistory): Record<string, string> {
  const models = historyModels(history)
  const labels: Record<string, string> = {}
  for (const model of models) {
    let label = usageModelLabel(model)
    if (model.model === null && !modelLess(model)) {
      const custom = models.filter(
        (other) =>
          other.provider === model.provider &&
          other.providerKey === model.providerKey &&
          other.model === null,
      )
      if (custom.length > 1) label += ` ${custom.findIndex((other) => other.id === model.id) + 1}`
    }
    labels[model.id] = label
  }
  const base = { ...labels }
  for (const model of models) {
    const connections = [
      ...new Set(
        models
          .filter((other) => base[other.id] === base[model.id])
          .map((other) => other.providerKey),
      ),
    ]
    if (connections.length > 1) {
      const providerConnections = [
        ...new Set(
          models
            .filter((other) => other.provider === model.provider)
            .map((other) => other.providerKey),
        ),
      ]
      labels[model.id] +=
        ` · ${i18n.t("options.apiUsage.history.connection")} ${providerConnections.indexOf(model.providerKey) + 1}`
    }
  }
  return labels
}
const modelColors = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#64748b"]
export function modelPattern(index: number) {
  return {
    backgroundColor: modelColors[index % modelColors.length],
    backgroundImage:
      index < modelColors.length
        ? "none"
        : `repeating-linear-gradient(${Math.floor(index / modelColors.length) % 2 === 0 ? 135 : 45}deg, transparent, transparent 8px, rgba(255,255,255,0.25) 8px, rgba(255,255,255,0.25) 9px)`,
  }
}
export function historyMetricValue(metrics: UsageMetrics, metric: HistoryMetric) {
  const reports = metric === "inputTokens" ? metrics.inputReports : metrics.outputReports
  return {
    value: metrics[metric],
    known: metric === "requests" || reports > 0,
    partial: metric !== "requests" && reports > 0 && reports < metrics.results,
  }
}
export const usedMetrics = (metrics: UsageMetrics) => metrics.requests > 0 || metrics.results > 0
