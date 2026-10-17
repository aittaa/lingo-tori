import type { SelectionToolbarCustomActionOutputField } from "@/types/config/selection-toolbar"
import type { SelectionToolbarCustomActionToken } from "@/utils/constants/custom-action"
import { SELECTION_TOOLBAR_CUSTOM_ACTION_TOKENS } from "@/utils/constants/custom-action"

export interface SelectionToolbarCustomActionPromptTokens {
  selection: string
  paragraphs: string
  targetLanguage: string
  webTitle: string
  webUrl: string
  webContent: string
}

/**
 * The one definition of what a token is: `{{name}}` for a name in the token list. Expansion and the
 * question "does this template use that token" both read it, so they cannot disagree.
 */
const TOKEN_PATTERN = new RegExp(
  `\\{\\{(${SELECTION_TOOLBAR_CUSTOM_ACTION_TOKENS.join("|")})\\}\\}`,
  "g",
)

/**
 * Expands the tokens of one template in a single pass. A value that is put in is final: if it looks
 * like a token (a page that contains the text `{{webUrl}}`, say) it stays text and is not expanded,
 * and a `$&`-style sequence in it stays as typed. That is what lets the data consent decision be
 * made from the template alone: a token is expanded exactly where the user's template wrote it.
 */
export function replaceSelectionToolbarCustomActionPromptTokens(
  prompt: string,
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  return prompt.replace(
    TOKEN_PATTERN,
    (_match, name: SelectionToolbarCustomActionToken) => tokens[name],
  )
}

function templateUsesToken(template: unknown, token: SelectionToolbarCustomActionToken): boolean {
  if (typeof template !== "string") return false
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    if (match[1] === token) return true
  }
  return false
}

/**
 * Whether running the action sends the full page URL to the provider: its prompt, its system prompt
 * or an output-field description uses the `{{webUrl}}` token. That is browsingActivity for Firefox's
 * data consent, and nothing else in an action's request is. Because expansion is a single pass over
 * these templates, a URL appears in the request exactly where this finds the token.
 */
export function customActionUsesWebUrl(action: {
  prompt: string
  systemPrompt: string
  outputSchema: ReadonlyArray<{ description: string }>
}): boolean {
  return [
    action.prompt,
    action.systemPrompt,
    ...action.outputSchema.map((f) => f.description),
  ].some((template) => templateUsesToken(template, "webUrl"))
}

export type StructuredOutputField = Pick<
  SelectionToolbarCustomActionOutputField,
  "name" | "type" | "description"
>

function formatYamlMultiline(value: string) {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

function formatStructuredOutputField(field: StructuredOutputField, resolvedDescription: string) {
  const description = resolvedDescription.trim()
  const descriptionBlock = description
    ? `  description: |-\n${formatYamlMultiline(description)}`
    : '  description: ""'

  return [
    `- key: ${JSON.stringify(field.name)}`,
    `  type: ${field.type}`,
    "  nullable: true",
    descriptionBlock,
  ].join("\n")
}

export function buildStructuredOutputFieldList(
  outputSchema: StructuredOutputField[],
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  return outputSchema
    .map((field) =>
      formatStructuredOutputField(
        field,
        replaceSelectionToolbarCustomActionPromptTokens(field.description, tokens),
      ),
    )
    .join("\n")
}

/**
 * The field list for descriptions that are already expanded (and, for the note suggestion, capped).
 * They are written as they are: expanding a value a second time would expand the text a page put
 * into it.
 */
export function formatResolvedStructuredOutputFieldList(outputSchema: StructuredOutputField[]) {
  return outputSchema
    .map((field) => formatStructuredOutputField(field, field.description))
    .join("\n")
}

function buildStructuredOutputContract(
  outputSchema: StructuredOutputField[],
  tokens: SelectionToolbarCustomActionPromptTokens,
) {
  const fieldsAndTypes = buildStructuredOutputFieldList(outputSchema, tokens)

  return `## Structured Output Contract
Return exactly one JSON object and nothing else.

### Required Keys and Types
${fieldsAndTypes}

### Hard Requirements
1. Include every required key exactly once.
2. Do not add any extra keys.
3. Use the exact key names shown above.
4. Output valid JSON only. Use double quotes for keys and string values.
5. Do not wrap the JSON in markdown or code fences.
6. If a value is unknown, use null.
7. Number fields must be JSON numbers, never quoted strings.
`
}

export function buildSelectionToolbarCustomActionSystemPrompt(
  prompt: string,
  tokens: SelectionToolbarCustomActionPromptTokens,
  outputSchema: StructuredOutputField[],
) {
  const resolvedPrompt = replaceSelectionToolbarCustomActionPromptTokens(prompt, tokens).trim()
  const contract = buildStructuredOutputContract(outputSchema, tokens)

  return resolvedPrompt ? `${resolvedPrompt}\n\n${contract}` : contract
}

export const CUSTOM_ACTION_CONTEXT_CHAR_LIMIT = 2000

export function truncateContextTextForCustomAction(
  contextText: string,
  limit = CUSTOM_ACTION_CONTEXT_CHAR_LIMIT,
) {
  return contextText.slice(0, limit)
}
