import type { LangCodeISO6393 } from "@/lib/languages"
import type { SelectionToolbarCustomActionOutputField } from "@/types/config/selection-toolbar"
import type { LayoutStatus } from "@/utils/layout-host/types"
import { FallbackFieldList } from "./fallback-field-list"

export interface CustomActionLayoutRenderInfo {
  error: string | null
  removed: string[]
  fellBack: boolean
}

interface CustomActionLayoutViewProps {
  outputSchema: readonly SelectionToolbarCustomActionOutputField[]
  value: Readonly<Record<string, unknown>> | null
  status: LayoutStatus
  className?: string
  // Legacy caller/config compatibility only. These values are never interpreted.
  source?: string
  selection?: string
  targetCode?: LangCodeISO6393
  theme?: "light" | "dark"
  speakSurface?: string
  onRenderInfo?: (info: CustomActionLayoutRenderInfo) => void
}

/** Independently authored plain field cards; no HTML, templates or audio adapters. */
export function CustomActionLayoutView({
  outputSchema,
  value,
  status,
  className,
}: CustomActionLayoutViewProps) {
  return (
    <div className={className}>
      <FallbackFieldList outputSchema={outputSchema} value={value} status={status} />
    </div>
  )
}
