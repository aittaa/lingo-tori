import { IconSettings } from "@tabler/icons-react"
import { useAtom, useAtomValue } from "jotai"
import { useEffect, useId, useRef, useState } from "react"
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

/**
 * How long the popup waits to hear from the background whether a page manager answered a toggle.
 * The messaging library has no timeout of its own, so a channel that stays open and never replies
 * would leave the button silently unusable. A chosen bound, not a measured one: long enough for a
 * cold-started service worker and a page whose main thread is busy, short enough that the user is
 * not left looking at a button that seems dead. An answer that comes later is dropped; the hint asks
 * for a refresh and a retry, and a repeated start or stop is harmless (the page skips a redundant
 * start, and a stop with nothing to stop does nothing).
 */
const TOGGLE_ANSWER_TIMEOUT_MS = 5_000

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

  // Set when the toggle reached no page manager or got no answer in time; cleared when the next
  // attempt starts.
  const [deliveryFailed, setDeliveryFailed] = useState(false)
  // The attempt now waiting for its answer, if any. Only the current attempt may change the screen:
  // one the popup gave up on (its deadline passed) is not current any more, so a reply that comes
  // in late, successful or not, is ignored.
  const currentAttempt = useRef<number | null>(null)
  const attemptCount = useRef(0)
  // The current attempt's deadline timer, kept here so that unmounting can disarm it.
  const deadlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // When this button goes away, an attempt still waiting has nobody to report to: disarm its
  // deadline and make it stale, so that a reply that comes later neither moves the shared
  // translated-state atom nor, if the tab was not known yet, sends the request at all. This is about
  // a React unmount under a store that stays alive; closing the real popup window destroys its
  // whole context anyway.
  useEffect(
    () => () => {
      if (deadlineTimer.current !== null) clearTimeout(deadlineTimer.current)
      deadlineTimer.current = null
      currentAttempt.current = null
    },
    [],
  )

  const toggleTranslation = async () => {
    if (needsProvider || currentAttempt.current !== null) return
    const attempt = ++attemptCount.current
    currentAttempt.current = attempt
    setDeliveryFailed(false)
    const deadline = setTimeout(() => {
      if (currentAttempt.current !== attempt) return
      // Stop waiting: release the button and say so.
      currentAttempt.current = null
      setDeliveryFailed(true)
    }, TOGGLE_ANSWER_TIMEOUT_MS)
    deadlineTimer.current = deadline
    try {
      const [currentTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      })
      if (currentAttempt.current !== attempt) return

      if (currentTab!.id) {
        const nextEnabled = !isPageTranslated
        // Flip only once a page manager in the tab has acknowledged the request. With no
        // receiver (a tab opened before the install, a context invalidated by an update,
        // a content script that failed to start) nothing is known to have changed on the page, so
        // the button does not flip and asks for a refresh. It is not synced to the page's real
        // state: what it shows is the last state a manager acknowledged, or the one the
        // background had recorded when the popup opened.
        // A start the manager received but refused (same language, no provider or key, cancelled by
        // an OFF) changed nothing either: the button stays on Translate, and the manager's own
        // notice on the page is the explanation, not a refresh hint.
        let delivered = false
        let startRefused = false
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
          startRefused = result.start === "rejected"
        } catch (error) {
          logger.warn("Failed to deliver the page translation toggle", error)
        }

        // Given up on while waiting (or replaced by a newer attempt): this reply is stale.
        if (currentAttempt.current !== attempt) return
        setDeliveryFailed(!delivered)
        if (delivered && !startRefused) setIsPageTranslated(nextEnabled)
      }
    } finally {
      clearTimeout(deadline)
      if (deadlineTimer.current === deadline) deadlineTimer.current = null
      if (currentAttempt.current === attempt) currentAttempt.current = null
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
