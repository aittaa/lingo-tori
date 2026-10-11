import type { LangCodeISO6393 } from "@/lib/languages"
import type {
  SelectionToolbarCustomActionOutputField,
  SelectionToolbarCustomActionSampleData,
} from "@/types/config/selection-toolbar"

// Preserve old sample data when editing/copying actions. There is no template preview.
export function createLayoutSampleData(
  outputSchema: readonly SelectionToolbarCustomActionOutputField[],
  targetCode: LangCodeISO6393,
): SelectionToolbarCustomActionSampleData {
  return {
    selection: "",
    targetCode,
    values: Object.fromEntries(outputSchema.map((field) => [field.id, ""])),
  }
}

export function syncLayoutSampleData(
  sampleData: SelectionToolbarCustomActionSampleData | undefined,
  outputSchema: readonly SelectionToolbarCustomActionOutputField[],
  targetCode: LangCodeISO6393,
): SelectionToolbarCustomActionSampleData {
  if (!sampleData) return createLayoutSampleData(outputSchema, targetCode)
  return {
    ...sampleData,
    values: Object.fromEntries(
      outputSchema.map((field) => [
        field.id,
        Object.hasOwn(sampleData.values, field.id) ? sampleData.values[field.id]! : "",
      ]),
    ),
  }
}
