import type { ReactNode } from "react"
import { use, useCallback, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/base-ui/tooltip"
import { useSelectionPopoverOverlayProps } from "@/components/ui/selection-popover"
import { SELECTION_CONTENT_OVERLAY_LAYERS } from "@/entrypoints/selection.content/overlay-layers"
import { ShadowWrapperContext } from "@/utils/react-shadow-host/create-shadow-host"
import { cn } from "@/utils/styles/utils"

const TOOLTIP_TRIGGER_PRESS_REASON = "trigger-press"
const TOOLTIP_ESCAPE_KEY_REASON = "escape-key"

interface SelectionTooltipOpenChangeDetails {
  reason: string
}

interface SelectionTooltipProps
  extends
    Pick<React.ComponentProps<typeof Tooltip>, "open" | "onOpenChange">,
    Pick<
      React.ComponentProps<typeof TooltipContent>,
      "align" | "alignOffset" | "className" | "side" | "sideOffset"
    > {
  children?: ReactNode
  content: ReactNode
  render: React.ReactElement
  container?: React.ComponentProps<typeof TooltipContent>["container"]
  positionerClassName?: string
}

export function useSelectionTooltipState() {
  const [open, setOpen] = useState(false)

  const handlePress = useCallback(() => {
    setOpen(true)
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean, eventDetails: SelectionTooltipOpenChangeDetails) => {
      if (!nextOpen && eventDetails.reason === TOOLTIP_TRIGGER_PRESS_REASON) {
        return
      }

      setOpen(nextOpen)
    },
    [],
  )

  return {
    handlePress,
    onOpenChange: handleOpenChange,
    open,
  }
}

function SelectionTooltip({
  align,
  alignOffset,
  children,
  className,
  container,
  content,
  onOpenChange,
  open,
  positionerClassName,
  render,
  side,
  sideOffset,
}: SelectionTooltipProps) {
  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipContent
        align={align}
        alignOffset={alignOffset}
        // This wrapper is only for selection-content overlays. In this path we
        // observed two separate real-browser failures:
        // 1) hover-leave could land on the tooltip overlay itself, so the
        //    browser never considered the pointer fully "back on the page";
        // 2) even after Base UI set the tooltip to the closed state, the node
        //    could remain visually visible until unmount.
        //
        // This path keeps the popup mouse-transparent while open so
        // hover-leave cannot land on the tooltip itself and contaminate the
        // hover chain.
        className={cn("pointer-events-none leading-5 whitespace-nowrap", className)}
        container={container}
        // The positioner is a separate overlay box around the popup. Making the
        // popup itself transparent is not enough if the pointer can still land
        // on this wrapper during hover leave.
        positionerClassName={cn("pointer-events-none", positionerClassName)}
        side={side}
        sideOffset={sideOffset}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export function SelectionToolbarTooltip(
  props: Omit<SelectionTooltipProps, "container" | "positionerClassName">,
) {
  const shadowWrapper = use(ShadowWrapperContext)

  return (
    <SelectionTooltip
      container={shadowWrapper ?? document.body}
      positionerClassName={SELECTION_CONTENT_OVERLAY_LAYERS.popoverOverlay}
      {...props}
    />
  )
}

export function SelectionPopoverTooltip({
  onOpenChange,
  ...props
}: Omit<SelectionTooltipProps, "container" | "positionerClassName">) {
  const popoverOverlay = useSelectionPopoverOverlayProps()

  // A hint tooltip handles Escape on its trigger and, by default, stops the event there. The
  // popover listens on the document, so while a hint was open (after a press, or while its button
  // had keyboard focus) the first Escape only hid the hint and the popover stayed. A hint is not a
  // layer the viewer works in: let the same Escape go on to the popover. Layers that are (a menu,
  // the context-details popover) still take their own Escape first, because the popover defers to
  // them itself.
  const handleOpenChange = useCallback<NonNullable<SelectionTooltipProps["onOpenChange"]>>(
    (nextOpen, eventDetails) => {
      if (!nextOpen && eventDetails.reason === TOOLTIP_ESCAPE_KEY_REASON) {
        eventDetails.allowPropagation()
      }
      onOpenChange?.(nextOpen, eventDetails)
    },
    [onOpenChange],
  )

  return (
    <SelectionTooltip
      onOpenChange={handleOpenChange}
      // Keep this workaround scoped to selection-content popovers. Shared
      // Tooltip primitives are also used by options/popup pages, which do not
      // need the same browser-specific close-state fix.
      container={popoverOverlay.container}
      positionerClassName={popoverOverlay.positionerClassName}
      {...props}
    />
  )
}
