import type { SubtitlePromptContext } from "@/types/content"
import { browser } from "#imports"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { normalizePromptContextValue } from "@/utils/host/translate/translate-text"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import { parsePromptTemplate } from "@/utils/prompts/template"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { CancelledScopeRegistry, TranslationCancelledError } from "@/utils/request/cancellation"
import { getQueueIdentity, isPrivateSender } from "./private-sender"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  buildTranslationScopeKey,
  createEphemeralQueueIdentity,
  createSubtitlesTranslationQueues,
  getLocalProviderConfig,
  shouldUseBatchQueue,
} from "./translation-queues"

/** Register handlers synchronously while queue initialization runs in the background. */
export function setupSubtitlesTranslationHandlers(): void {
  // The runs that were ended, and the tabs that were closed, since this worker started. Consulted
  // by the enqueue handler after its cache lookup and by the batch queue after a backoff sleep:
  // both are windows where a request lives in no cancellable structure (#1881).
  const cancelledScopes = new CancelledScopeRegistry()
  const queuesPromise = createSubtitlesTranslationQueues(cancelledScopes)

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
        ownerId,
      },
    } = message
    // The run that asked, as `${tab}:${run}`. Built here from the sender's tab, so a tab can only
    // ever cancel its own requests. A request with no run (the export, an older content script)
    // has no scope and is never cancellable — it also keeps alive any item it shares.
    const scope = buildTranslationScopeKey(message.sender, ownerId)
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

    // The cache lookup above yielded — the run may have ended, or its tab closed, while this
    // handler was suspended. Enqueueing now would park a request on a dead scope that no later
    // cancel will ever drain, so refuse instead (the content side swallows this error).
    if (scope && cancelledScopes.has(scope)) {
      throw new TranslationCancelledError(scope)
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
    const requestQueueHash = hash
      ? legacyPromptResolution
        ? Sha256Hex("legacy-prompt-resolution", hash)
        : hash
      : createEphemeralQueueIdentity()
    // Both separations apply to a request that is both: the legacy tag first, then the private
    // namespace on top, so normal/private x snapshot/legacy are four distinct identities. A
    // normal snapshot request keeps the raw hash; a request without a hash keeps its own
    // ephemeral identity (renamespaced, still unique, when private).
    const queueHash = getQueueIdentity(requestQueueHash, isPrivate)

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
        scope,
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
      result = await requestQueue.enqueue(thunk, scheduleAt, queueHash, scope ? [scope] : undefined)
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

  onMessage("cancelSubtitlesTranslateRequests", async (message) => {
    const scope = buildTranslationScopeKey(message.sender, message.data.ownerId)
    if (!scope) return
    // Remember the scope BEFORE any await so enqueue handlers suspended on the cache lookup
    // refuse to enqueue after this drain.
    cancelledScopes.markScope(scope)
    const { requestQueue, batchQueue } = await queuesPromise
    // Batch queue first so pending batches cannot flush new request-queue tasks between the two
    // drains. Both only remove what no other owner still wants.
    const cancelledBatch = batchQueue.cancelByScope(scope)
    const cancelledRequests = requestQueue.cancelByScope(scope)
    if (cancelledBatch + cancelledRequests > 0) {
      logger.info(
        `Cancelled ${cancelledBatch + cancelledRequests} subtitle requests (scope: ${scope})`,
      )
    }
  })

  // A closed tab can never send its cancel message — sweep every run the tab ever started.
  browser.tabs.onRemoved.addListener((tabId) => {
    const prefix = `${tabId}:`
    cancelledScopes.markPrefix(prefix)
    void queuesPromise.then(({ requestQueue, batchQueue }) => {
      batchQueue.cancelWhere((scope) => scope.startsWith(prefix))
      requestQueue.cancelWhere((scope) => scope.startsWith(prefix))
    })
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
