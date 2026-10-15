import { IconSettings } from "@tabler/icons-react"
import { useAtom, useAtomValue } from "jotai"
import { useId, useRef, useState } from "react"
import { browser } from "#imports"
import { Button } from "@/components/ui/base-ui/button"
import { Kbd, KbdGroup } from "@/components/ui/base-ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/base-ui/tooltip"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { featureProviderRefAtom } from "@/utils/atoms/provider"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import {
  buildFeatureProviderRoute,
  getFeatureProviderRowId,
  openOptionsPage,
} from "@/utils/navigation"
import { formatHotkeyParts } from "@/utils/os.ts"
import { isShortcutEmpty } from "@/utils/shortcut"
import { cn } from "@/utils/styles/utils"
import { isPageTranslatedAtom } from "../atoms/auto-translate"
import { isIgnoreTabAtom } from "../atoms/ignore"
import { isCurrentSiteInBlacklistAtom, isCurrentSiteInWhitelistAtom } from "../atoms/site-control"

export default function TranslateButton({ className }: { className?: string }) {
  const [isPageTranslated, setIsPageTranslated] = useAtom(isPageTranslatedAtom)
  const isIgnoreTab = useAtomValue(isIgnoreTabAtom)
  const translateConfig = useAtomValue(configFieldsAtomMap.pageTranslation)
  const { mode } = useAtomValue(configFieldsAtomMap.siteControl)
  const isCurrentSiteInWhitelist = useAtomValue(isCurrentSiteInWhitelistAtom)
  const isCurrentSiteInBlacklist = useAtomValue(isCurrentSiteInBlacklistAtom)

  const providerRef = useAtomValue(featureProviderRefAtom("pageTranslation"))
  const descriptionId = useId()
  // Showing the original needs no provider; only starting a translation does.
  const needsProvider = !isPageTranslated && !providerRef

  // Set when the toggle reached no page manager; cleared by the next attempt.
  const [deliveryFailed, setDeliveryFailed] = useState(false)
  const toggleInFlight = useRef(false)

  const toggleTranslation = async () => {
    if (needsProvider || toggleInFlight.current) return
    toggleInFlight.current = true
    try {
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      })

      if (currentTab!.id) {
        const nextEnabled = !isPageTranslated
        // Flip only once a page manager in the tab has acknowledged the request. With no
        // receiver (a tab opened before the install, a context invalidated by an update,
        // a content script that failed to start) nothing changed on the page, so the
        // button keeps showing what is true and asks for a refresh.
        let delivered = false
        try {
          const result = await sendMessage("tryToSetEnablePageTranslationByTabId", {
            tabId: currentTab!.id,
            enabled: nextEnabled,
            analyticsContext: nextEnabled
              ? createFeatureUsageContext(
                  ANALYTICS_FEATURE.PAGE_TRANSLATION,
                  ANALYTICS_SURFACE.POPUP,
                )
              : undefined,
          })
          delivered = result.delivered
        } catch (error) {
          logger.warn("Failed to deliver the page translation toggle", error)
        }

        setDeliveryFailed(!delivered)
        if (delivered) setIsPageTranslated(nextEnabled)
      }
    } finally {
      toggleInFlight.current = false
    }
  }

  const isSiteBlocked = mode === "whitelist" ? !isCurrentSiteInWhitelist : isCurrentSiteInBlacklist
  const isDisabled = isIgnoreTab || isSiteBlocked
  const shortcutParts = isShortcutEmpty(translateConfig.page.shortcut)
    ? []
    : formatHotkeyParts(translateConfig.page.shortcut)

  const button = (
    <Button
      onClick={toggleTranslation}
      disabled={isDisabled || needsProvider}
      aria-describedby={needsProvider ? descriptionId : undefined}
      className={cn("min-w-0", needsProvider ? "w-full" : className)}
    >
      <span className="flex max-w-full min-w-0 items-center justify-center gap-2">
        <span className="min-w-0 truncate">
          {isPageTranslated ? i18n.t("popup.showOriginal") : i18n.t("popup.translate")}
        </span>
        {!isPageTranslated && shortcutParts.length > 0 && (
          <KbdGroup className="shrink-0">
            {shortcutParts.map((part) => (
              <Kbd key={part} className="bg-primary-foreground/20 text-primary-foreground">
                {part}
              </Kbd>
            ))}
          </KbdGroup>
        )}
      </span>
    </Button>
  )

  const refreshHint = deliveryFailed ? (
    <p role="alert" className="w-full text-xs text-destructive">
      {i18n.t("popup.refreshNeeded")}
    </p>
  ) : null

  if (!needsProvider) {
    return (
      <>
        {button}
        {refreshHint}
      </>
    )
  }

  const description = i18n.t("providerRequired.message")

  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex min-w-0 flex-1 cursor-not-allowed" />}>
          {button}
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={i18n.t("providerRequired.openSettings")}
        aria-describedby={descriptionId}
        onClick={() =>
          void openOptionsPage({
            route: buildFeatureProviderRoute(getFeatureProviderRowId("pageTranslation")),
          })
        }
      >
        <IconSettings className="size-4" />
      </Button>
    </span>
  )
}
