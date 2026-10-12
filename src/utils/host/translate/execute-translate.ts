import type { PromptResolver } from "./api/ai"
import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { MatchedTerm } from "@/utils/glossary/types"
import { ISO6393_TO_6391, LANG_CODE_TO_EN_NAME } from "@/lib/languages"
import { isLLMProviderConfig, isPureAPIProvider } from "@/types/config/provider"
import { aiTranslate } from "./api/ai"
import { deeplTranslate } from "./api/deepl"
import { deeplxTranslate } from "./api/deeplx"
import { prepareTranslationText } from "./text-preparation"
import { normalizeTranslationOutput } from "./translation-output-normalization"

export async function executeTranslate<TContext>(
  text: string,
  langConfig: Config["language"],
  providerConfig: ProviderConfig,
  promptResolver: PromptResolver<TContext>,
  options?: {
    usageFeature?: ApiUsageFeature
    isBatch?: boolean
    context?: TContext
    textFormat?: TranslationTextFormat
    // Only Google needs protection: its translateHtml transport collapses
    // "\n" as HTML whitespace. Microsoft preserves newlines in both textTypes
    // (live-verified); LLM prompts already mandate format preservation.
    preserveLineBreaks?: boolean
    signal?: AbortSignal
    glossaryTerms?: readonly MatchedTerm[]
  },
) {
  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  const { provider } = providerConfig
  let translatedText = ""

  if (isPureAPIProvider(provider)) {
    const sourceLang =
      langConfig.sourceCode === "auto" ? "auto" : (ISO6393_TO_6391[langConfig.sourceCode] ?? "auto")
    const targetLang = ISO6393_TO_6391[langConfig.targetCode]
    if (!targetLang) {
      throw new Error(`Invalid target language code: ${langConfig.targetCode}`)
    }
    if (provider === "deeplx") {
      translatedText = await deeplxTranslate(preparedText, sourceLang, targetLang, providerConfig, {
        textFormat: options?.textFormat,
        signal: options?.signal,
        usageFeature: options?.usageFeature,
      })
    } else if (provider === "deepl") {
      translatedText = await deeplTranslate(text, sourceLang, targetLang, providerConfig, {
        textFormat: options?.textFormat,
        signal: options?.signal,
        usageFeature: options?.usageFeature,
      })
    }
  } else if (isLLMProviderConfig(providerConfig)) {
    const targetLangName = LANG_CODE_TO_EN_NAME[langConfig.targetCode]
    translatedText = await aiTranslate(
      preparedText,
      targetLangName,
      providerConfig,
      promptResolver,
      options,
    )
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }

  return normalizeTranslationOutput(providerConfig, translatedText).trim()
}
