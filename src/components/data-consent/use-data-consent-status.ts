import type { DataConsentCategory, DataConsentStatus } from "@/utils/firefox-data-consent"
import { useCallback, useEffect, useState } from "react"
import {
  getDataConsentStatus,
  isDataConsentBuild,
  watchDataConsent,
} from "@/utils/firefox-data-consent"

/**
 * Where Firefox's grant for a category stands, for a settings page. It is read when the page opens,
 * when the window regains focus or becomes visible (the way back from about:addons), and when the
 * browser reports a permission change if it does. A page that shows this is only informing the
 * user: every request reads the browser itself.
 */
export function useDataConsentStatus(category: DataConsentCategory) {
  const [status, setStatus] = useState<DataConsentStatus | null>(null)

  const refresh = useCallback(() => {
    void getDataConsentStatus(category).then(setStatus)
  }, [category])

  useEffect(() => {
    if (!isDataConsentBuild()) return undefined
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    const stopWatching = watchDataConsent(refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
      stopWatching()
    }
  }, [refresh])

  return { status: isDataConsentBuild() ? status : ("not-applicable" as const), refresh }
}
