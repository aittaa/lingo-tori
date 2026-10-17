import type { DataConsentCategory } from "@/utils/firefox-data-consent"
import { useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { requestDataConsent } from "@/utils/firefox-data-consent"
import { i18n } from "@/utils/i18n"
import { cn } from "@/utils/styles/utils"
import { useDataConsentStatus } from "./use-data-consent-status"

const COPY_KEYS = {
  authenticationInfo: {
    title: "dataConsent.authenticationInfo.title",
    description: "dataConsent.authenticationInfo.description",
  },
  browsingActivity: {
    title: "dataConsent.browsingActivity.title",
    description: "dataConsent.browsingActivity.description",
  },
} as const

/**
 * Firefox's built-in data consent for one optional category: what it covers, where it stands, and
 * the button that asks. The button is the user gesture `permissions.request` needs, and the request
 * starts in the click handler before anything else runs. Nothing shows on a Chrome build.
 */
export function DataConsentRow({
  category,
  className,
}: {
  category: DataConsentCategory
  className?: string
}) {
  const { status, refresh } = useDataConsentStatus(category)
  const [refused, setRefused] = useState(false)

  if (status === null || status === "not-applicable") return null

  const handleAllow = () => {
    setRefused(false)
    void requestDataConsent(category).then((granted) => {
      setRefused(!granted)
      refresh()
    })
  }

  const keys = COPY_KEYS[category]
  return (
    <div
      role="group"
      aria-label={i18n.t(keys.title)}
      className={cn("flex flex-col gap-2 rounded-lg border border-border p-3 text-sm", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{i18n.t(keys.title)}</span>
        <span role="status" className="text-xs text-muted-foreground">
          {i18n.t(`dataConsent.status.${status}`)}
        </span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{i18n.t(keys.description)}</p>
      {status === "denied" && (
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="xs" onClick={handleAllow}>
            {i18n.t("dataConsent.allow")}
          </Button>
          {refused && (
            <span role="alert" className="text-xs text-destructive">
              {i18n.t("dataConsent.allowFailed")}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
