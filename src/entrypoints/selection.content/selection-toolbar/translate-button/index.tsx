import { IconLanguage, IconSettings } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { useId } from "react"
import { SelectionPopover } from "@/components/ui/selection-popover"
import { SelectionToolbarTooltip } from "@/components/ui/selection-popover/selection-tooltip"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { buildFeatureProviderRoute, getFeatureProviderRowId } from "@/utils/navigation"
import { selectionToolbarTranslateRequestAtom } from "../atoms"
import { ShortcutTooltipLabel } from "../shortcut-hint"
import { useSelectionTranslationPopover } from "./provider"

export function TranslateButton() {
  const { prepareToolbarOpen } = useSelectionTranslationPopover()
  const selectionToolbar = useAtomValue(configFieldsAtomMap.selectionToolbar)
  // The request slice already resolves this feature's own provider; null covers unset, deleted,
  // disabled and unsupported alike. Other features' providers do not matter here.
  const { provider } = useAtomValue(selectionToolbarTranslateRequestAtom)
  const descriptionId = useId()
  const triggerLabel = i18n.t("action.translation")

  if (!provider) {
    const description = i18n.t("providerRequired.message")

    return (
      <SelectionToolbarTooltip
        content={description}
        render={<span className="flex shrink-0 cursor-not-allowed items-center" />}
      >
        <button
          type="button"
          disabled
          aria-label={triggerLabel}
          aria-describedby={descriptionId}
          className="pointer-events-none flex h-7 shrink-0 items-center justify-center px-2 opacity-50"
        >
          <IconLanguage className="size-4.5" />
        </button>
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
        <button
          type="button"
          aria-label={`${triggerLabel}: ${i18n.t("providerRequired.openSettings")}`}
          aria-describedby={descriptionId}
          className="flex h-7 shrink-0 cursor-pointer items-center justify-center px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            void sendMessage("openOptionsPage", {
              route: buildFeatureProviderRoute(getFeatureProviderRowId("selectionTranslation")),
            })
          }
        >
          <IconSettings className="size-3.5" />
        </button>
      </SelectionToolbarTooltip>
    )
  }

  return (
    <SelectionToolbarTooltip
      content={
        <ShortcutTooltipLabel
          label={triggerLabel}
          shortcut={selectionToolbar.features.translate.shortcut}
        />
      }
      render={
        <SelectionPopover.Trigger
          aria-label={triggerLabel}
          onClick={(event) => {
            event.currentTarget.blur()
            prepareToolbarOpen()
          }}
        />
      }
    >
      <IconLanguage className="size-4.5" />
    </SelectionToolbarTooltip>
  )
}
