import { storage } from "#imports"
import { API_USAGE_STORAGE_KEY, createApiUsageRecorder } from "@/utils/api-usage"
import { API_USAGE_HISTORY_KEY, createApiUsageHistoryRecorder } from "@/utils/api-usage-history"
import { installApiUsageObserver, installApiUsageResultObserver } from "@/utils/api-usage-tracking"
import { onMessage } from "@/utils/message"

export function setupApiUsage() {
  const recorder = createApiUsageRecorder({
    read: () => storage.getItem(API_USAGE_STORAGE_KEY),
    write: (usage) => storage.setItem(API_USAGE_STORAGE_KEY, usage),
  })
  const history = createApiUsageHistoryRecorder({
    read: () => storage.getItem(API_USAGE_HISTORY_KEY),
    write: (value) => storage.setItem(API_USAGE_HISTORY_KEY, value),
  })
  installApiUsageObserver((feature, transport, identity) => {
    recorder.record(feature, transport)
    if (identity) history.attempt(feature, identity)
  })
  installApiUsageResultObserver((feature, identity, tokens) =>
    history.result(feature, identity, tokens),
  )
  onMessage("getApiUsage", async () => {
    const [totals, details] = await Promise.all([recorder.snapshot(), history.snapshot()])
    return { ...totals, ...details }
  })
}
