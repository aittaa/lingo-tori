import { resolveLanguageCodeFromLocale } from "@/utils/content/page-language"

export type AutoTranslateDecision =
  | "start"
  | "disabled"
  | "manual-off"
  | "unknown-language"
  | "same-language"

export interface AutoTranslateInput {
  /** `videoSubtitles.autoStart`. */
  enabled: boolean
  /** The track's language as the platform reports it ("en", "en-US", ""). */
  sourceLanguage: string | null | undefined
  /** The language the viewer reads in; the caller decides which setting stands for it. */
  myLanguage: string | null | undefined
  /** The viewer switched this video's subtitles off themselves. */
  manualOff: boolean
}

/**
 * Whether opening a video should switch translation on by itself. Only a video whose language is
 * known and differs from the viewer's gets it: a language that cannot be told is held back rather
 * than guessed at, and a track already in the viewer's language has nothing to translate.
 *
 * Both sides go through the same locale resolution the same-language passthrough uses, so the two
 * never disagree about what counts as the same language. Switching on by hand never comes here.
 */
export function decideAutoTranslate({
  enabled,
  sourceLanguage,
  myLanguage,
  manualOff,
}: AutoTranslateInput): AutoTranslateDecision {
  if (!enabled) return "disabled"
  if (manualOff) return "manual-off"

  const source = resolveLanguageCodeFromLocale(sourceLanguage)
  const mine = resolveLanguageCodeFromLocale(myLanguage)
  if (!source || !mine) return "unknown-language"

  return source === mine ? "same-language" : "start"
}
