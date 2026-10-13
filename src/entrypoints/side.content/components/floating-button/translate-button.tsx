import type { FloatingButtonSide } from "@/types/config/floating-button"
import { IconCheck, IconLanguage } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { cn } from "@/utils/styles/utils"
import { enablePageTranslationAtom } from "../../atoms"
import HiddenButton from "./components/hidden-button"

export default function TranslateButton({
  className,
  side = "right",
  expanded = false,
}: {
  className?: string
  side?: FloatingButtonSide
  expanded?: boolean
}) {
  const translationState = useAtomValue(enablePageTranslationAtom)
  const isEnabled = translationState.enabled

  return (
    <HiddenButton
      icon={<IconLanguage className="h-5 w-5" />}
      label={i18n.t("options.floatingButton.tooltips.togglePageTranslation")}
      className={className}
      side={side}
      expanded={expanded}
      onClick={() => {
        const nextEnabled = !isEnabled
        void sendMessage("tryToSetEnablePageTranslationOnContentScript", {
          enabled: nextEnabled,
          // Only a start needs to be identifiable as the user's; stopping needs no context.
          analyticsContext: nextEnabled
            ? createFeatureUsageContext(
                ANALYTICS_FEATURE.PAGE_TRANSLATION,
                ANALYTICS_SURFACE.FLOATING_BUTTON,
              )
            : undefined,
        })
      }}
    >
      <IconCheck
        className={cn(
          "absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full bg-success text-white",
          isEnabled ? "block" : "hidden",
        )}
      />
    </HiddenButton>
  )
}
