import type { SelectionToolbarCustomActionOutputField } from "@/types/config/selection-toolbar"
import type { LayoutStatus } from "@/utils/layout-host/types"
import { formatResultValue } from "@/utils/layout-host/format-value"

interface FallbackFieldListProps {
  outputSchema: readonly SelectionToolbarCustomActionOutputField[]
  value: Readonly<Record<string, unknown>> | null
  status: LayoutStatus
}

/** The primary result view: only React text nodes, including for partial model output. */
export function FallbackFieldList({ outputSchema, value, status }: FallbackFieldListProps) {
  return (
    <dl
      className="space-y-3"
      data-slot="custom-action-field-list"
      aria-busy={status === "streaming"}
    >
      {outputSchema.map((field) => {
        const present = value !== null && Object.hasOwn(value, field.name)
        const pending = status === "streaming" && !present
        return (
          <div key={field.id} className="rounded-md border p-3" data-slot="custom-action-field-row">
            <dt className="text-xs font-medium break-words text-muted-foreground">{field.name}</dt>
            <dd className="mt-1 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">
              {pending ? "…" : formatResultValue(present ? value[field.name] : undefined)}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
