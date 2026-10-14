import type { ProviderRequestRouting } from "@/types/hosted-request"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { RequestQueue } from "@/utils/request/request-queue"
import { generateArticleSummary } from "@/utils/content/summary"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { logger } from "@/utils/logger"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"
import { generateTextForProviderRef } from "./background-stream"
import { getQueueIdentity } from "./private-sender"

/**
 * Cached summaries used as context by webpage and subtitle translation.
 * The caller supplies its feature queue and cache identity.
 *
 * `persist: false` (a private-window sender) generates the summary without
 * reading or writing the persistent summary cache, and keeps the request out of
 * any queue slot a persisting request could share.
 */
export async function getOrGenerateTranslationContextSummary(
  args: ProviderRequestRouting<PromptableProviderRef> & {
    title: string
    textContent: string
    cacheKeyParts: string[]
    usageFeature: ApiUsageFeature
    requestQueue: RequestQueue
    persist?: boolean
  },
): Promise<string | null> {
  const { title, textContent, providerRef, cacheKeyParts, requestQueue, persist = true } = args
  const preparedText = cleanText(textContent)
  if (!preparedText) {
    return null
  }

  const cacheKey = Sha256Hex(...cacheKeyParts, getProviderCacheIdentity(providerRef))

  if (persist) {
    const cached = await db.articleSummaryCache.get(cacheKey)
    if (cached) {
      logger.info("Using cached summary")
      return cached.summary
    }
  }

  const thunk = async (signal?: AbortSignal) => {
    if (persist) {
      const cachedAgain = await db.articleSummaryCache.get(cacheKey)
      if (cachedAgain) {
        return cachedAgain.summary
      }
    }

    const summary = await generateArticleSummary(
      title,
      textContent,
      { providerRef },
      {
        signal,
        generate: (payload, runOptions) =>
          generateTextForProviderRef(payload, { ...runOptions, usageFeature: args.usageFeature }),
      },
    )
    if (!summary) {
      return ""
    }

    if (!persist) {
      logger.info("Generated new summary (private sender, not cached)")
      return summary
    }

    await db.articleSummaryCache.put({
      key: cacheKey,
      summary,
      createdAt: new Date(),
    })

    logger.info("Generated and cached new summary")
    return summary
  }

  try {
    const summary = await requestQueue.enqueue(
      thunk,
      Date.now(),
      getQueueIdentity(cacheKey, !persist),
    )
    return summary || null
  } catch (error) {
    logger.warn("Failed to get/generate summary:", error)
    return null
  }
}
