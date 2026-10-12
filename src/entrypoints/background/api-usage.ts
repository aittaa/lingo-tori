import { storage } from "#imports"
import { API_USAGE_STORAGE_KEY, createApiUsageRecorder } from "@/utils/api-usage"
import { installApiUsageObserver } from "@/utils/api-usage-tracking"
import { onMessage } from "@/utils/message"

export function setupApiUsage() {
  const recorder = createApiUsageRecorder({
    read: () => storage.getItem(API_USAGE_STORAGE_KEY),
    write: (usage) => storage.setItem(API_USAGE_STORAGE_KEY, usage),
  })
  installApiUsageObserver(recorder.record)
  onMessage("getApiUsage", () => recorder.snapshot())
}
