import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { useState } from "react"
import { toastManager } from "@/components/ui/base-ui/toast"
import { detectLanguageWithSource } from "@/utils/content/language"
import { getUiLocale } from "@/utils/i18n"
import { learningCopy, learningLocale } from "@/utils/learning/copy"
import { sendLearningMessage } from "@/utils/learning/messages"

interface SaveVocabularyRequest {
  action: SelectionToolbarCustomAction
  results: Array<Record<string, unknown>>
  selection?: string
  context?: string
  language?: string
  analyticsSource?: string
}
export function useSaveVocabulary() {
  const [isSaving, setIsSaving] = useState(false)
  const save = async (request: SaveVocabularyRequest): Promise<"saved" | "failed"> => {
    const copy = learningCopy[learningLocale(getUiLocale())]
    setIsSaving(true)
    try {
      const sourceLanguage =
        request.language && request.language !== "auto"
          ? request.language
          : (await detectLanguageWithSource(request.context || request.selection || "")).code
      const notes = request.results.map((result) => {
        const entries = request.action.outputSchema
          .map((field) => [field.name, result[field.name]] as const)
          .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
        const primary = entries[0]
        const term =
          request.selection ||
          (typeof result.term === "string"
            ? result.term
            : typeof result.word === "string"
              ? result.word
              : primary?.[1]) ||
          ""
        const meaning =
          typeof result.meaning === "string"
            ? result.meaning
            : entries
                .filter((entry) => entry !== primary || request.selection)
                .map(([name, value]) => `${name}: ${value}`)
                .join("\n")
        return {
          term,
          meaning,
          context: request.context ?? "",
          language: sourceLanguage,
          sourceUrl: window.location.href,
        }
      })
      await sendLearningMessage("lingotoriSave", notes)
      toastManager.add({
        type: "success",
        title: copy.saved,
        actionProps: {
          children: copy.open,
          onClick: () => {
            void sendLearningMessage("lingotoriOpenStudy", undefined)
          },
        },
      })
      return "saved"
    } catch {
      toastManager.add({ type: "error", title: copy.failed })
      return "failed"
    } finally {
      setIsSaving(false)
    }
  }
  return { save, isSaving }
}
// Compatibility name while existing selection-toolbar callers migrate.
export const useSaveToNotebase = useSaveVocabulary
