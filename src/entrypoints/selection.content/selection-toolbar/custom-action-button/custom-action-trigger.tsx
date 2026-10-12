import type { MouseEvent } from "react"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { Icon } from "@iconify/react"
import { IconSettings } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { useCallback, useId } from "react"
import { SelectionToolbarTooltip } from "@/components/ui/selection-popover/selection-tooltip"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { buildFeatureProviderRoute, getCustomActionProviderRowId } from "@/utils/navigation"
import { selectionToolbarCustomActionRequestAtomFamily } from "../atoms"
import { ShortcutTooltipLabel } from "../shortcut-hint"
import { useSelectionCustomActionPopover } from "./provider"

export function SelectionToolbarCustomActionTrigger({
  action,
}: {
  action: SelectionToolbarCustomAction
}) {
  const { openToolbarCustomAction } = useSelectionCustomActionPopover()
  // Each action runs on its own provider; null covers unset, deleted, disabled and unsupported.
  const { provider } = useAtomValue(selectionToolbarCustomActionRequestAtomFamily(action.id))
  const descriptionId = useId()

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!provider) return
      event.currentTarget.blur()
      openToolbarCustomAction(action.id, event.currentTarget)
    },
    [action.id, openToolbarCustomAction, provider],
  )

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
          aria-label={action.name}
          aria-describedby={descriptionId}
          className="pointer-events-none flex h-7 shrink-0 items-center justify-center px-2 opacity-50"
        >
          <Icon icon={action.icon} strokeWidth={0.8} className="size-4.5" />
        </button>
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
        <button
          type="button"
          aria-label={`${action.name}: ${i18n.t("providerRequired.openSettings")}`}
          aria-describedby={descriptionId}
          className="flex h-7 shrink-0 cursor-pointer items-center justify-center px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            void sendMessage("openOptionsPage", {
              route: buildFeatureProviderRoute(getCustomActionProviderRowId(action.id)),
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
      content={<ShortcutTooltipLabel label={action.name} shortcut={action.shortcut} />}
      render={
        <button
          type="button"
          aria-label={action.name}
          className="flex h-7 shrink-0 cursor-pointer items-center justify-center px-2 hover:bg-muted"
          onClick={handleClick}
        />
      }
    >
      <Icon icon={action.icon} strokeWidth={0.8} className="size-4.5" />
    </SelectionToolbarTooltip>
  )
}
