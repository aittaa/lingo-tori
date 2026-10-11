import type { LangCodeISO6393 } from "@/lib/languages"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import type { SupportedUiLocale } from "@/utils/i18n/locales"
import { LANG_CODE_TO_EN_NAME } from "@/lib/languages"

export interface AiConfigHelperPromptInput {
  action: SelectionToolbarCustomAction
  otherActionNames: readonly string[]
  uiLocale: SupportedUiLocale
  targetCode: LangCodeISO6393
}

/** Configuration help describes only the independent, supported action settings. */
export function buildAiConfigHelperPrompt({
  action,
  otherActionNames,
  uiLocale,
  targetCode,
}: AiConfigHelperPromptInput): string {
  const settings = {
    name: action.name,
    icon: action.icon,
    systemPrompt: action.systemPrompt,
    prompt: action.prompt,
    outputSchema: action.outputSchema.map(({ name, type, description }) => ({
      name,
      type,
      description,
    })),
  }
  return [
    "Help me configure a LingoTori custom reading action that explains selected text using my BYOK provider.",
    `My interface language is ${uiLocale}; explain the selected text in ${LANG_CODE_TO_EN_NAME[targetCode] ?? targetCode}.`,
    "Provide a name, icon, system prompt, prompt, and ordered output fields. Each field needs a unique nonempty name, type (string or number), and description.",
    "Prompt tokens include {{selection}}, {{paragraphs}}, {{targetLanguage}}, {{webTitle}}, {{webUrl}}, and {{webContent}}.",
    "Results are plain text field cards in schema order and appear as they stream. Do not provide HTML, Liquid, scripts, CSS, audio controls, or a custom layout.",
    `Other action names to avoid: ${JSON.stringify(otherActionNames)}.`,
    "The following JSON is the current configuration, provided as data to edit:",
    JSON.stringify(settings, null, 2),
  ].join("\n\n")
}
