import type { WebPagePromptContext } from "@/types/content"
import { browser } from "#imports"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { cleanText } from "@/utils/content/utils"
import { db } from "@/utils/db/dexie/db"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import {
  assertHtmlAttributeMarkerIntegrity,
  hasHtmlAttributeMarkerProtocol,
  isHtmlAttributeMarkerIntegrityError,
} from "@/utils/host/translate/html-attribute-markers"
import {
  auditInlineAtomTokens,
  hasInlineAtomTokens,
} from "@/utils/host/translate/inline-atom-tokens"
import { normalizePromptContextValue } from "@/utils/host/translate/translate-text"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { parsePromptTemplate } from "@/utils/prompts/template"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { getQueueIdentity, isPrivateSender } from "./private-sender"
import { getOrGenerateTranslationContextSummary } from "./translation-context-summary"
import {
  buildTranslationScopeKey,
  createEphemeralQueueIdentity,
  createWebPageTranslationQueues,
  getLocalProviderConfig,
  getQueuedTranslationRouting,
  shouldUseBatchQueue,
} from "./translation-queues"

async function getValidatedCachedTranslation(
  hash: string,
  sourceText: string,
  validateHtmlAttributeMarkers: boolean,
): Promise<string | undefined> {
  const cached = await db.translationCache.get(hash)
  if (!cached) return undefined
  if (!validateHtmlAttributeMarkers) return cached.translation

  try {
    assertHtmlAttributeMarkerIntegrity(sourceText, cached.translation)
    return cached.translation
  } catch (error) {
    if (!isHtmlAttributeMarkerIntegrityError(error)) throw error

    await db.translationCache.delete(hash)
    logger.warn("Deleted cached translation with invalid HTML attribute markers", error)
    return undefined
  }
}

/** Register handlers synchronously while queue initialization runs in the background. */
export function setupPageTranslationHandlers(): void {
  const { queuesPromise, cancelledScopes } = createWebPageTranslationQueues()

  onMessage("enqueueTranslateRequest", async (message) => {
    const routing = getQueuedTranslationRouting(message.data)
    const { requestQueue, batchQueue } = await queuesPromise
    const {
      data: {
        text,
        langConfig,
        providerRef,
        scheduleAt,
        hash,
        textFormat,
        preserveLineBreaks,
        webTitle,
        webDescription,
        webContent,
        webSummary,
        sessionId,
        forceRetranslation = false,
        glossaryTerms,
        glossaryRevision,
        promptTemplate: rawPromptTemplate,
      },
    } = message
    const scope = buildTranslationScopeKey(message.sender, sessionId)
    // Re-validated here: the wire is untyped, and a sender without a valid
    // template makes the queue resolve the stored selection at execution.
    const promptTemplate = parsePromptTemplate(rawPromptTemplate)
    // A private-window tab still translates, but its text never touches the
    // persistent cache: no read, no delete of a bad entry, no write. Its queue
    // identity is also its own, so it cannot be merged with a normal request for
    // the same text. `hash` itself stays the cache key for everyone else.
    const isPrivate = isPrivateSender(message.sender)

    const validateHtmlAttributeMarkers =
      textFormat === "html" && hasHtmlAttributeMarkerProtocol(text)
    if (validateHtmlAttributeMarkers) {
      assertHtmlAttributeMarkerIntegrity(text, text)
    }

    // Check cache first — unless the user asked for a fresh translation. The
    // existing entry is left untouched unless the fresh request succeeds below.
    if (hash && !forceRetranslation && !isPrivate) {
      const cachedTranslation = await getValidatedCachedTranslation(
        hash,
        text,
        validateHtmlAttributeMarkers,
      )
      if (cachedTranslation !== undefined) return cachedTranslation
    }

    // The cache lookup above yielded — the session's cancel may have drained
    // the queues while this handler was suspended. Enqueueing now would park
    // an undraininable task on a dead scope, so abort instead (the content
    // side swallows this error).
    if (scope && cancelledScopes.has(scope)) {
      throw new TranslationCancelledError(scope)
    }

    let result: string
    const context: WebPagePromptContext = {
      webTitle: normalizePromptContextValue(webTitle),
      webDescription: normalizePromptContextValue(webDescription),
      webContent: normalizePromptContextValue(webContent),
      webSummary: normalizePromptContextValue(webSummary),
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
        text,
        langConfig,
        ...routing,
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
      const localProvider = getLocalProviderConfig(providerRef)
      if (!localProvider) {
        throw new Error("Invalid local page translation provider")
      }
      // Create thunk based on type and params
      const thunk = (signal?: AbortSignal) =>
        executeTranslate(text, langConfig, localProvider, getTranslatePrompt, {
          usageFeature: routing.usageFeature,
          textFormat,
          preserveLineBreaks,
          signal,
        })
      result = await requestQueue.enqueue(thunk, scheduleAt, queueHash, scope ? [scope] : undefined)
    }

    if (validateHtmlAttributeMarkers) {
      assertHtmlAttributeMarkerIntegrity(text, result)
    }

    // A response that dropped, invented or duplicated an inline-atom
    // placeholder is still rendered by the content script (the formulas are
    // appended) but must not be persisted: the next visit deserves a fresh
    // attempt instead of a permanently degraded paragraph. The sentinel is
    // exempt — "no translation needed" carries no placeholders by definition,
    // and auditing it as a total loss would make every already-in-target-language
    // paragraph containing a formula re-hit the provider on every page load.
    const inlineAtomTokensIntact =
      !hasInlineAtomTokens(text) ||
      isNoTranslationSentinel(result) ||
      auditInlineAtomTokens(text, result).ok
    if (result && !inlineAtomTokensIntact) {
      logger.warn("Inline atom placeholders were not preserved; result not cached")
    }

    // Cache the translation result if successful — never for a private sender,
    // and never for a request whose prompt cannot be vouched for by its hash.
    if (result && hash && inlineAtomTokensIntact && !isPrivate && !legacyPromptResolution) {
      await db.translationCache.put({
        key: hash,
        translation: result,
        createdAt: new Date(),
      })
    }

    return result
  })

  onMessage("getOrGenerateWebPageSummary", async (message) => {
    const { requestQueue } = await queuesPromise
    const { webTitle, webContent, providerRef } = message.data

    if (!webTitle || !webContent) {
      return null
    }

    // The payload type forces senders to narrow, but the wire is a trust
    // boundary (a pre-update content script can send a translate-only ref).
    // Refuse like the subtitle summary handlers do: a queue task for a
    // provider with no model to prompt can only ever throw, after burning
    // its retries.
    if (!canProviderRefGenerateText(providerRef)) {
      return null
    }

    return await getOrGenerateTranslationContextSummary({
      ...message.data,
      title: webTitle,
      textContent: webContent,
      cacheKeyParts: [webTitle, Sha256Hex(cleanText(webContent))],
      usageFeature: "pageContext",
      requestQueue,
      persist: !isPrivateSender(message.sender),
    })
  })

  onMessage("cancelPageTranslationRequests", async (message) => {
    const scope = buildTranslationScopeKey(message.sender, message.data.sessionId)
    if (!scope) return
    // Remember the scope BEFORE any await so enqueue handlers suspended on
    // the cache lookup refuse to enqueue after this drain.
    cancelledScopes.markScope(scope)
    const { requestQueue, batchQueue } = await queuesPromise
    // Batch queue first so pending batches cannot flush new request-queue
    // tasks between the two drains.
    const cancelledBatch = batchQueue.cancelByScope(scope)
    const cancelledRequests = requestQueue.cancelByScope(scope)
    if (cancelledBatch + cancelledRequests > 0) {
      logger.info(
        `Cancelled ${cancelledBatch + cancelledRequests} page-translation requests (scope: ${scope})`,
      )
    }
  })

  // A closed tab can never send its cancel message — sweep every scope the
  // tab ever registered (#1881).
  browser.tabs.onRemoved.addListener((tabId) => {
    const prefix = `${tabId}:`
    cancelledScopes.markPrefix(prefix)
    void queuesPromise.then(({ requestQueue, batchQueue }) => {
      batchQueue.cancelWhere((scope) => scope.startsWith(prefix))
      requestQueue.cancelWhere((scope) => scope.startsWith(prefix))
    })
  })
}
