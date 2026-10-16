import type { BackgroundGenerateTextPayload } from "@/types/background-generate-text"
import type { ProviderRequestRouting } from "@/types/hosted-request"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { logger } from "@/utils/logger"
import { getArticleSummaryPrompt } from "@/utils/prompts/summary"
import { isAbortedByCancellation } from "@/utils/request/cancellation"
import { MAX_TEXT_LENGTH } from "./utils"
import { cleanText } from "./utils"

/** The article title is untrusted page text; bound it like the body. */
const MAX_TITLE_LENGTH = 200

/**
 * Generate a brief summary of article content for translation context.
 */
export async function generateArticleSummary(
  title: string,
  textContent: string,
  routing: ProviderRequestRouting<PromptableProviderRef>,
  options: {
    signal?: AbortSignal
    generate: (
      payload: BackgroundGenerateTextPayload,
      runOptions: { signal?: AbortSignal },
    ) => Promise<string>
  },
): Promise<string | null> {
  const preparedText = cleanText(textContent, MAX_TEXT_LENGTH)

  if (!preparedText) {
    return null
  }

  try {
    const { systemPrompt, prompt } = getArticleSummaryPrompt(
      cleanText(title, MAX_TITLE_LENGTH),
      preparedText,
    )

    const payload: BackgroundGenerateTextPayload = {
      providerRef: routing.providerRef,
      instructions: systemPrompt,
      prompt,
    }
    const summary = await options.generate(payload, { signal: options.signal })

    const cleanedSummary = summary.trim()
    logger.info("Generated article summary:", `${cleanedSummary.slice(0, 100)}...`)

    return cleanedSummary
  } catch (error) {
    // The request's owner left and the queue aborted its signal: the provider's abort error is
    // only the echo of that, not a failed generation. Any other error keeps its error log,
    // whatever it is named.
    if (isAbortedByCancellation(options.signal)) {
      logger.info("Article summary generation cancelled")
      return null
    }
    logger.error("Failed to generate article summary:", error)
    return null
  }
}
