import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { IconBookmarkPlus } from "@tabler/icons-react"
import { Button } from "@/components/ui/base-ui/button"
import { getUiLocale } from "@/utils/i18n"
import { learningCopy, learningLocale } from "@/utils/learning/copy"
import { useSaveVocabulary } from "./use-save-to-notebase"
export function SaveVocabularyButton({
  action,
  isRunning,
  result,
  selection,
  context,
  language,
}: {
  action: SelectionToolbarCustomAction
  isRunning: boolean
  result: Record<string, unknown> | null
  selection?: string
  context?: string
  language?: string
}) {
  const { save, isSaving } = useSaveVocabulary()
  const copy = learningCopy[learningLocale(getUiLocale())]
  return (
    <Button
      type="button"
      variant="brand"
      size="sm"
      disabled={isRunning || !result || isSaving}
      onClick={() => {
        if (result) void save({ action, results: [result], selection, context, language })
      }}
    >
      <IconBookmarkPlus className="size-4" />
      {isSaving ? copy.saving : copy.save}
    </Button>
  )
}
export const SaveToNotebaseButton = SaveVocabularyButton
