import type { PromptTemplate } from "./template"
import type { TranslatePromptOptions, TranslatePromptResult } from "./translate"
import type { Config } from "@/types/config/config"
import type { SubtitlePromptContext } from "@/types/content"
import { getLocalConfig } from "@/utils/config/storage"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { appendGlossaryToSystemPrompt } from "@/utils/glossary/prompt"
import { DEFAULT_CONFIG } from "../constants/config"
import {
  BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS,
  DEFAULT_BATCH_TRANSLATE_PROMPT,
  DEFAULT_TRANSLATE_PROMPT_ID,
  getTokenCellText,
  SUBTITLE_INPUT,
  SUBTITLE_TARGET_LANGUAGE,
  SUBTITLE_WEB_DESCRIPTION,
  SUBTITLE_WEB_TITLE,
  VIDEO_SUMMARY,
} from "../constants/prompt"
import { replacePromptTokens } from "./replace-tokens"
import { resolvePromptReplacementValue } from "./translate"

/** The prompt a config selects, as stored: built-in, else the matching custom pattern, else the default. */
export function selectSubtitlesPromptTemplate(
  customPromptsConfig: Config["videoSubtitles"]["customPromptsConfig"],
): PromptTemplate {
  const { patterns, promptId } = customPromptsConfig

  const resolvedPromptId = promptId || DEFAULT_TRANSLATE_PROMPT_ID
  const builtInPrompt = Object.hasOwn(BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS, resolvedPromptId)
    ? BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS[
        resolvedPromptId as keyof typeof BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS
      ]
    : undefined
  const customPrompt = patterns.find((pattern) => pattern.id === resolvedPromptId)
  const selectedPrompt =
    builtInPrompt ??
    customPrompt ??
    BUILT_IN_SUBTITLE_TRANSLATE_PROMPTS[DEFAULT_TRANSLATE_PROMPT_ID]

  // Only the two prompt strings — see `selectTranslatePromptTemplate`.
  return { systemPrompt: selectedPrompt.systemPrompt, prompt: selectedPrompt.prompt }
}

/** Snapshot the stored subtitle prompt selection — once per request, where its cache key is hashed. */
export async function getSubtitlesPromptTemplate(): Promise<PromptTemplate> {
  const config = (await getLocalConfig()) ?? DEFAULT_CONFIG
  return selectSubtitlesPromptTemplate(config.videoSubtitles.customPromptsConfig)
}

export async function getSubtitlesTranslatePrompt(
  targetLang: string,
  input: string,
  options?: TranslatePromptOptions<SubtitlePromptContext>,
): Promise<TranslatePromptResult> {
  // A request that carries both its template and its terms consults no stored
  // setting — see `getTranslatePrompt`.
  const carriesOwnSettings =
    options?.promptTemplate !== undefined && options.glossaryTerms !== undefined
  const config = carriesOwnSettings ? DEFAULT_CONFIG : ((await getLocalConfig()) ?? DEFAULT_CONFIG)

  let { systemPrompt, prompt } =
    options?.promptTemplate ??
    selectSubtitlesPromptTemplate(config.videoSubtitles.customPromptsConfig)

  // For batch mode, append batch rules to system prompt
  if (options?.isBatch) {
    systemPrompt = `${systemPrompt}

${DEFAULT_BATCH_TRANSLATE_PROMPT}`
  }

  // Build title and summary replacement values
  const title = resolvePromptReplacementValue(options?.context?.webTitle, "No title available")
  const description = resolvePromptReplacementValue(
    options?.context?.webDescription,
    "No description available",
  )
  const summary = resolvePromptReplacementValue(
    options?.context?.videoSummary,
    "No summary available",
  )

  // Replace tokens in both prompts, in one pass over each template (see
  // `replacePromptTokens`): cue text and video metadata land literally and are
  // never scanned again for tokens.
  const replacements = {
    [getTokenCellText(SUBTITLE_TARGET_LANGUAGE)]: targetLang,
    [getTokenCellText(SUBTITLE_INPUT)]: input,
    [getTokenCellText(SUBTITLE_WEB_TITLE)]: title,
    [getTokenCellText(SUBTITLE_WEB_DESCRIPTION)]: description,
    [getTokenCellText(VIDEO_SUMMARY)]: summary,
  }
  const replaceTokens = (text: string) => replacePromptTokens(text, replacements)

  // Same contract as the page-translation builder: appended AFTER token
  // replacement so a term cannot rewrite the prompt around it, and omitted
  // entirely when nothing matched so the prompt — which subtitles also fold into
  // their cache key (subtitles/processor/translator.ts:143) — stays identical
  // for a user whose glossary missed this cue.
  const resolvedSystemPrompt = replaceTokens(systemPrompt)
  const glossaryTerms =
    options?.glossaryTerms ??
    (await resolveGlossaryTerms(input, config.glossary.enabled, config.language.targetCode)).terms
  return {
    systemPrompt: appendGlossaryToSystemPrompt(resolvedSystemPrompt, glossaryTerms),
    prompt: replaceTokens(prompt),
  }
}
