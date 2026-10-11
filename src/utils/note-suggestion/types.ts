import { z } from "zod"

/** Keep each suggestion batch short enough for a learner to review individually. */
export const NOTE_SUGGESTION_MAX_NOTES = 5

export const noteSuggestionNoteFieldSchema = z.strictObject({
  name: z.string(),
  value: z.union([z.string(), z.number()]).nullable(),
})

export const noteSuggestionNoteSchema = z.strictObject({
  fields: z.array(noteSuggestionNoteFieldSchema),
})

/**
 * Client-owned structured-output schema of the note suggestion, passed to
 * `Output.object` when streaming from the user's selection-translate LLM
 * provider (the nested shape cannot go through the flat structured-object
 * port schema).
 */
export const noteSuggestionEnvelopeSchema = z.strictObject({
  /**
   * Display hint: which schema field's value best explains the term in one
   * line. The key is required and its value is nullable because OpenAI strict
   * structured outputs do not support optional object properties.
   */
  summaryFieldName: z.string().nullable(),
  notes: z.array(noteSuggestionNoteSchema).max(NOTE_SUGGESTION_MAX_NOTES),
})

export type NoteSuggestionEnvelope = z.infer<typeof noteSuggestionEnvelopeSchema>
export type NoteSuggestionNote = z.infer<typeof noteSuggestionNoteSchema>

export type NoteSuggestionNoteRecord = Record<string, string | number | null>

export interface ValidatedNoteSuggestion {
  /** Notes keyed by output-field name, validated against the selected action's schema. */
  notes: NoteSuggestionNoteRecord[]
  /**
   * Sanitized display hint: a non-primary field name of the target action
   * whose value best explains the term, or null (fall back to schema order).
   */
  summaryFieldName: string | null
}
