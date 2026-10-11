import type { NoteSuggestionSessionResult } from "./use-note-suggestion"
import type { NoteSuggestionNoteRecord } from "@/utils/note-suggestion/types"
import { IconBook2 } from "@tabler/icons-react"
import { useAtom } from "jotai"
import { useEffect } from "react"
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/base-ui/field"
import { Label } from "@/components/ui/base-ui/label"
import { Switch } from "@/components/ui/base-ui/switch"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { trackNoteSuggestionEvent } from "@/utils/note-suggestion/analytics"

function formatNoteValue(value: string | number | null): string | null {
  if (value === null) {
    return null
  }

  const text = typeof value === "number" ? String(value) : value.trim()
  return text.length > 0 ? text : null
}

function NoteRow({
  note,
  primaryFieldName,
  secondaryFieldNames,
}: {
  note: NoteSuggestionNoteRecord
  primaryFieldName: string
  secondaryFieldNames: string[]
}) {
  const primaryValue = formatNoteValue(note[primaryFieldName] ?? null)
  const secondaryValue = secondaryFieldNames
    .map((fieldName) => formatNoteValue(note[fieldName] ?? null))
    .find((value) => value !== null)

  return (
    <Field orientation="horizontal" className="gap-2 p-2!">
      <FieldContent className="min-w-0 gap-0.5">
        <FieldTitle>{primaryValue}</FieldTitle>
        {secondaryValue && (
          <FieldDescription className="text-xs">{secondaryValue}</FieldDescription>
        )}
      </FieldContent>
    </Field>
  )
}

export function NoteSuggestionCard({
  suggestion,
  markShownOnce,
}: {
  suggestion: NoteSuggestionSessionResult
  markShownOnce: (sessionKey: string) => boolean
}) {
  const { sessionKey, validated, actionSnapshot, firedAt, analyticsProvider } = suggestion
  const [selectionToolbar, setSelectionToolbar] = useAtom(configFieldsAtomMap.selectionToolbar)
  useEffect(() => {
    if (!markShownOnce(sessionKey)) {
      return
    }

    trackNoteSuggestionEvent({
      action_id: "suggestion_shown",
      startedAt: firedAt,
      provider: analyticsProvider,
    })
  }, [markShownOnce, sessionKey, firedAt, analyticsProvider])

  const primaryFieldName = actionSnapshot.outputSchema[0]?.name
  if (!primaryFieldName) {
    return null
  }
  // Secondary line preference: the AI-designated summary field first (it
  // knows which field explains the term, whatever the user named it), then
  // definition-like fields (dictionary template's stable ids), then schema
  // order. Later entries only show when earlier ones are empty.
  const aiSummaryFieldName = validated.summaryFieldName
  const secondaryFields = actionSnapshot.outputSchema.slice(1)
  const secondaryFieldNames = [
    ...secondaryFields.filter((field) => field.name === aiSummaryFieldName),
    ...secondaryFields.filter(
      (field) => field.name !== aiSummaryFieldName && field.id.includes("definition"),
    ),
    ...secondaryFields.filter(
      (field) => field.name !== aiSummaryFieldName && !field.id.includes("definition"),
    ),
  ].map((field) => field.name)
  return (
    <div
      data-slot="note-suggestion-card"
      className="notranslate mx-4 mb-4 space-y-2 rounded-lg border bg-muted/40 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <IconBook2 className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="truncate">{i18n.t("noteSuggestion.title")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            id="note-suggestion-toggle"
            size="sm"
            checked={selectionToolbar.noteSuggestion.enabled}
            onCheckedChange={(checked) => {
              void setSelectionToolbar({
                noteSuggestion: { ...selectionToolbar.noteSuggestion, enabled: checked },
              })
            }}
          />
          <Label
            htmlFor="note-suggestion-toggle"
            className="text-xs font-normal text-muted-foreground"
          >
            {i18n.t("noteSuggestion.toggleLabel")}
          </Label>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{i18n.t("noteSuggestion.description")}</p>
      <div className="space-y-1">
        {validated.notes.map((note, index) => (
          <NoteRow
            // oxlint-disable-next-line react/no-array-index-key -- notes are a stable per-session snapshot
            key={index}
            note={note}
            primaryFieldName={primaryFieldName}
            secondaryFieldNames={secondaryFieldNames}
          />
        ))}
      </div>
    </div>
  )
}
