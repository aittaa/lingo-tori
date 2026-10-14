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
import { getQueueIdentity, isPrivateSender } from "./private-sender"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
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
    // See `enqueueTranslateRequest`: a private-window tab never touches the
    // persistent cache and never shares a queue identity with a normal tab.
    const isPrivate = isPrivateSender(message.sender)

    if (hash && !isPrivate) {
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
    // An empty hash stays empty, because BatchQueue dedups only on a non-empty key and a
    // tag would turn it into one shared by every such request.
    const legacyPromptResolution = promptTemplate === undefined && shouldUseBatchQueue(providerRef)
    // Both separations apply to a request that is both: the legacy tag first, then
    // the private namespace on top, so normal/private x snapshot/legacy are four
    // distinct identities. A normal snapshot request keeps the raw hash, and an empty hash
    // stays empty through both steps.
    const queueHash = getQueueIdentity(
      legacyPromptResolution && hash ? Sha256Hex("legacy-prompt-resolution", hash) : hash,
      isPrivate,
    )

    if (shouldUseBatchQueue(providerRef)) {
      const data = {
        usageFeature: "subtitlesTranslation" as const,
        text,
        langConfig,
        provider: providerRef,
        hash: queueHash,
        privateSender: isPrivate,
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

    // Never cached for a private sender, nor for a request whose prompt its hash
    // cannot vouch for.
    if (result && hash && !isPrivate && !legacyPromptResolution) {
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
      persist: !isPrivateSender(message.sender),
    })
  })
}
