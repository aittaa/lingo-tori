import type { ReactNode } from "react"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { withForm } from "./form"

// Keep existing form composition compatible while removing the obsolete layout UI.
export const LayoutField = withForm({
  defaultValues: {} as SelectionToolbarCustomAction,
  render: function Render() {
    return null
  },
})

export function ReadOnlyLayoutField(_props: {
  action: Pick<SelectionToolbarCustomAction, "layout" | "outputSchema" | "sampleData">
  customizeButton?: ReactNode
}) {
  return null
}
