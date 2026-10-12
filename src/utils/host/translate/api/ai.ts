import type { LLMProviderConfig } from "@/types/config/provider"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { TranslatePromptOptions, TranslatePromptResult } from "@/utils/prompts/translate"
import { generateText } from "ai"
import { createApiUsageReporter } from "@/utils/api-usage-tracking"
import { extractAISDKErrorMessage } from "@/utils/error/extract-message"
import { getLanguageModelForConfig } from "@/utils/providers/model"
import { resolveModelId } from "@/utils/providers/model-id"
import { getProviderOptionsWithOverride } from "@/utils/providers/options"
import { getTopLevelReasoning } from "@/utils/providers/reasoning"
import { attachRequestErrorMeta, getRequestErrorMeta } from "@/utils/request/retry-policy"

const THINK_TAG_RE = /<\/think>([\s\S]*)/

export type PromptResolver<TContext = unknown> = (
  targetLang: string,
  input: string,
  options?: TranslatePromptOptions<TContext>,
) => Promise<TranslatePromptResult>

export async function aiTranslate<TContext>(
  text: string,
  targetLangName: string,
  providerConfig: LLMProviderConfig,
  promptResolver: PromptResolver<TContext>,
  options?: {
    usageFeature?: ApiUsageFeature
    isBatch?: boolean
    context?: TContext
    signal?: AbortSignal
    // Forwarded verbatim to the prompt resolver: the terms were resolved by the
    // context that knew the page URL, and re-resolving here would scope them
    // wrong (see `TranslatePromptOptions.glossaryTerms`).
    glossaryTerms?: readonly MatchedTerm[]
  },
) {
  const {
    model: providerModel,
    provider,
    providerOptions: userProviderOptions,
    temperature,
  } = providerConfig
  const reasoning = getTopLevelReasoning(providerConfig)
  const modelName = resolveModelId(providerModel)
  const model = getLanguageModelForConfig(providerConfig, options?.usageFeature)

  const providerOptions = getProviderOptionsWithOverride(
    modelName ?? "",
    provider,
    userProviderOptions,
    reasoning,
  )
  const { systemPrompt, prompt } = await promptResolver(targetLangName, text, options)

  const reporter = createApiUsageReporter(model, options?.usageFeature)
  try {
    const { text: translatedText, usage } = await generateText({
      model,
      instructions: systemPrompt,
      prompt,
      reasoning,
      temperature,
      providerOptions,
      abortSignal: options?.signal,
      maxRetries: 0, // Disable SDK built-in retries, let RequestQueue/BatchQueue handle it
    })

    reporter.observe(usage)
    const [, finalTranslation = translatedText] = translatedText.match(THINK_TAG_RE) || []

    return finalTranslation
  } catch (error) {
    const message = extractAISDKErrorMessage(error)
    const meta = getRequestErrorMeta(error)
    if (error instanceof Error) {
      error.message = message
      throw attachRequestErrorMeta(error, meta)
    }

    throw attachRequestErrorMeta(new Error(message), meta)
  } finally {
    reporter.finish()
  }
}
