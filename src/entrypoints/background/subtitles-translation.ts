import type { SubtitlePromptContext } from "@/types/content"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { normalizePromptContextValue } from "@/utils/host/translate/translate-text"
import { onMessage } from "@/utils/message"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import { parsePromptTemplate } from "@/utils/prompts/template"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  createEphemeralQueueIdentity,
  createSubtitlesTranslationQueues,
  getLocalProviderConfig,
  shouldUseBatchQueue,
} from "./translation-queues"

/** Register handlers synchronously while queue initialization runs in the background. */
export function setupSubtitlesTranslationHandlers(): void {
  const queuesPromise = createSubtitlesTranslationQueues()

  onMessage("enqueueSubtitlesTranslateRequest", async (message) => {
    const { requestQueue, batchQueue } = await queuesPromise
    const {
      data: {
        text,
        langConfig,
        providerRef,
        scheduleAt,
        hash,
        webTitle,
        webDescription,
        summary,
        glossaryTerms,
        glossaryRevision,
        promptTemplate: rawPromptTemplate,
      },
    } = message
    // See the page handler: anything but a well-formed template means "resolve
    // the stored selection at execution", as before.
    const promptTemplate = parsePromptTemplate(rawPromptTemplate)

    if (hash) {
      const cached = await db.translationCache.get(hash)
      if (cached) {
        return cached.translation
      }
    }

    let result: string
    const context: SubtitlePromptContext = {
      webTitle: normalizePromptContextValue(webTitle),
      webDescription: normalizePromptContextValue(webDescription),
      videoSummary: normalizePromptContextValue(summary),
    }

    // A prompt-using request with no valid snapshot (an old content script, or a
    // malformed payload) runs whatever prompt is stored when it is dispatched, so
    // its `hash` does not say which prompt produced its result. It still
    // translates, but it must neither share a queue identity with a snapshot
    // request of the same hash (BatchQueue and RequestQueue both dedup on it) nor
    // persist its result under that hash for a snapshot request to be served later.
    const legacyPromptResolution = promptTemplate === undefined && shouldUseBatchQueue(providerRef)

    // What both queues dedup on, minted once per request. `hash` itself keeps deciding every
    // cache read and write (an empty one means "never cached"); it must not also be the queue
    // key, because every empty-hash request would then share one and a different text would be
    // handed the first one's result. A request without a hash gets an identity of its own.
    const queueHash = hash
      ? legacyPromptResolution
        ? Sha256Hex("legacy-prompt-resolution", hash)
        : hash
      : createEphemeralQueueIdentity()

    if (shouldUseBatchQueue(providerRef)) {
      const data = {
        usageFeature: "subtitlesTranslation" as const,
        text,
        langConfig,
        provider: providerRef,
        hash: queueHash,
        scheduleAt,
        context,
        // Kept off `context`, which is part of the batch key — see
        // `mergeBatchGlossaryTerms`.
        glossaryTerms,
        glossaryRevision,
        // The prompt this request's `hash` was taken over. Part of the batch
        // key, so a batch never mixes two prompts.
        promptTemplate,
      }
      result = await batchQueue.enqueue(data)
    } else {
      const localConfig = getLocalProviderConfig(providerRef)
      const thunk = (signal?: AbortSignal) =>
        executeTranslate(text, langConfig, localConfig, getSubtitlesTranslatePrompt, {
          usageFeature: "subtitlesTranslation",
          signal,
          glossaryTerms,
        })
      result = await requestQueue.enqueue(thunk, scheduleAt, queueHash)
    }

    if (result && hash && !legacyPromptResolution) {
      await db.translationCache.put({
        key: hash,
        translation: result,
        createdAt: new Date(),
      })
    }

    return result
  })

  onMessage("getSubtitlesSummary", async (message) => {
    const { requestQueue } = await queuesPromise
    const { videoTitle, subtitlesContext, providerRef } = message.data

    // Guarded on both sides: the content script should not send this for a
    // provider with no model to prompt, and the queue must not admit a task
    // that can only throw if it does.
    if (!videoTitle || !subtitlesContext || !canProviderRefGenerateText(providerRef)) {
      return null
    }

    return await getOrGenerateTranslationContextSummary({
      title: videoTitle,
      textContent: subtitlesContext,
      providerRef,
      // Deliberately without the title, matching the previous key: a video's
      // transcript identifies it, and including a title that players mutate
      // would miss the cache on every re-render.
      cacheKeyParts: [Sha256Hex(cleanText(subtitlesContext))],
      usageFeature: "subtitlesContext",
      requestQueue,
    })
  })
}
