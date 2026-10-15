import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { BatchQueueConfig, RequestQueueConfig } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { ProviderRequestRouting } from "@/types/hosted-request"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { PromptResolver } from "@/utils/host/translate/api/ai"
import type { PromptTemplate } from "@/utils/prompts/template"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { storage } from "#imports"
import { isLLMProviderConfig } from "@/types/config/provider"
import { apiUsageFeatureSchema } from "@/utils/api-usage"
import { putBatchRequestRecord } from "@/utils/batch-request-record"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR, BATCH_SEPARATOR_LINE_PATTERN } from "@/utils/constants/prompt"
import {
  BATCH_TIMEOUT_BASE_MS,
  BATCH_TIMEOUT_PER_CHAR_MS,
  MAX_BATCH_TIMEOUT_MS,
} from "@/utils/constants/translate"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import { logger } from "@/utils/logger"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { BatchQueue } from "@/utils/request/batch-queue"
import { CancelledScopeRegistry } from "@/utils/request/cancellation"
import { RequestQueue } from "@/utils/request/request-queue"
import { ensureInitializedConfig } from "./config"

type QueuedTranslationProvider = ProviderConfig | SerializableProviderRef

type QueuedTranslationRouting = {
  provider: QueuedTranslationProvider
  usageFeature?: ApiUsageFeature
}
export function getQueuedTranslationRouting(
  request: ProviderRequestRouting & { usageFeature?: ApiUsageFeature },
): QueuedTranslationRouting {
  return {
    provider: request.providerRef,
    usageFeature: apiUsageFeatureSchema.safeParse(request.usageFeature).data ?? "sharedRequests",
  }
}

function isSerializedPageProvider(
  provider: QueuedTranslationProvider,
): provider is SerializableProviderRef {
  return "kind" in provider && provider.kind === "local"
}

export function getLocalProviderConfig(provider: QueuedTranslationProvider): ProviderConfig {
  if (!isSerializedPageProvider(provider)) return provider
  return provider.config
}

async function executeQueuedTranslation<TContext>(
  text: string,
  langConfig: Config["language"],
  routing: QueuedTranslationRouting,
  promptResolver: PromptResolver<TContext>,
  options: {
    isBatch?: boolean
    context?: TContext
    textFormat?: import("@/types/config/translate").TranslationTextFormat
    preserveLineBreaks?: boolean
    signal?: AbortSignal
    glossaryTerms?: readonly MatchedTerm[]
    promptTemplate?: PromptTemplate
  } = {},
): Promise<string> {
  return executeTranslate(
    text,
    langConfig,
    getLocalProviderConfig(routing.provider),
    promptResolver,
    { ...options, usageFeature: routing.usageFeature ?? "sharedRequests" },
  )
}

export function parseBatchResult(result: string): string[] {
  return result
    .trim()
    .split(BATCH_SEPARATOR_LINE_PATTERN)
    .map((t) => t.trim())
}

export function shouldUseBatchQueue(provider: QueuedTranslationProvider): boolean {
  const local = getLocalProviderConfig(provider)
  return local ? isLLMProviderConfig(local) : true
}

let ephemeralQueueIdentitySeq = 0

/**
 * The queue identity of a request that has no cache hash.
 *
 * An empty `hash` means "do not cache this", but both queues still dedup on a key, and an
 * empty (or member-derived) key is one every such request shares: the second, different text
 * would be handed the first one's result without its own thunk ever running. This is that key,
 * minted once per request and used wherever the hash would have been, so a request is only ever
 * deduped with itself (a retry or fallback of the same request keeps the identity).
 *
 * Per-request, never cached (the handlers keep the ORIGINAL hash for every cache decision), and
 * it can never equal a SHA-256 hex digest. It carries no text, key or headers.
 */
export function createEphemeralQueueIdentity(): string {
  return `ephemeral-queue:${++ephemeralQueueIdentitySeq}`
}

/**
 * The glossary terms for a whole batch: every member's terms, deduped.
 *
 * Each item resolved its own terms against its own text, so the union is what
 * the joined text would have matched — minus any term that only appears to span
 * the separator between two paragraphs, which was never really there.
 *
 * The term LIST is deliberately not part of `getBatchKey` — it differs per
 * paragraph, so keying on it would put every paragraph in a batch of its own and
 * end batching for anyone using a glossary. The glossary REVISION is in the key
 * instead: one global counter that every paragraph of a page carries alike, so
 * it costs nothing in the steady state while guaranteeing that a batch holds
 * exactly one glossary state.
 *
 * That guarantee is what makes this union sound, and it cannot be recovered by
 * any rule applied here, because a term's ABSENCE from a member is overloaded:
 * "the user deleted it", "my text does not contain it", "the feature was
 * switched off mid-page" (which bumps no revision at all) and "my snapshot timed
 * out" are the same value. Without the key component, a member carrying an
 * emptied list could not out-vote an older member's term, the prompt would apply
 * the removed wording to that member's text, and the result would be cached
 * under a hash built with NO terms — the hash a re-translation computes too, so
 * nothing would ever evict it.
 *
 * The revision comparison below is therefore defence in depth rather than the
 * live mechanism, kept so that a future change to the batch key cannot silently
 * reintroduce the mixed-state batch. What IS still live is the tie: equal
 * revisions carrying DIFFERENT wordings cannot happen within one glossary state,
 * so it means the stamp is not trustworthy for that key — `readSnapshot` reads
 * the revision and the entries separately while a writer commits its rows before
 * bumping, leaving a sub-millisecond window where post-edit entries come back
 * under a pre-edit revision. There the term is DROPPED rather than guessed at:
 * sending no instruction costs the user the wording once, whereas guessing sends
 * a wording that is wrong half the time and then caches it.
 */
function mergeBatchGlossaryTerms<TContext>(
  dataList: readonly TranslateBatchData<TContext>[],
): MatchedTerm[] | undefined {
  // `undefined` means "nobody resolved terms", which lets the prompt resolver
  // fall back to resolving them itself. An empty array means "resolved, nothing
  // matched" and must suppress that fallback.
  if (dataList.every((data) => data.glossaryTerms === undefined)) return undefined

  const byMatchKey = new Map<string, { term: MatchedTerm; revision: number }>()
  // Keys whose wording two members disagreed on at the SAME revision. Cleared
  // again if a strictly newer revision turns up, which settles the key outright.
  const unresolvable = new Set<string>()

  for (const data of dataList) {
    // Absent for a sender that predates the field (an old content script still
    // live across an update). 0 loses every disagreement, which is the safe way
    // round: a member that cannot say how fresh its terms are never displaces
    // one that can.
    const revision = data.glossaryRevision ?? 0
    for (const term of data.glossaryTerms ?? []) {
      const existing = byMatchKey.get(term.matchKey)
      if (existing === undefined) {
        byMatchKey.set(term.matchKey, { term, revision })
        continue
      }
      if (revision > existing.revision) {
        byMatchKey.set(term.matchKey, { term, revision })
        unresolvable.delete(term.matchKey)
        continue
      }
      if (revision === existing.revision && !isSameWording(existing.term, term)) {
        unresolvable.add(term.matchKey)
      }
    }
  }

  for (const matchKey of unresolvable) byMatchKey.delete(matchKey)

  return [...byMatchKey.values()]
    .map(({ term }) => term)
    .sort((a, b) => a.matchKey.localeCompare(b.matchKey))
}

/**
 * Whether two hits on one `matchKey` say the same thing.
 *
 * All three fields come from the indexed glossary entry rather than from the
 * page's surface text (`utils/glossary/matcher.ts`), so two hits produced from
 * the same glossary state are identical and this only ever separates hits
 * produced from DIFFERENT states.
 */
function isSameWording(a: MatchedTerm, b: MatchedTerm): boolean {
  return a.target === b.target && a.keepOriginal === b.keepOriginal && a.source === b.source
}

export async function executeBatchTranslation<TContext>(
  dataList: TranslateBatchData<TContext>[],
  promptResolver: PromptResolver<TContext>,
  signal?: AbortSignal,
): Promise<string[]> {
  const { langConfig, context } = dataList[0]!
  const texts = dataList.map((d) => d.text)

  const batchText = texts.join(`\n\n${BATCH_SEPARATOR}\n\n`)
  const result = await executeQueuedTranslation(
    batchText,
    langConfig,
    {
      ...dataList[0]!,
      usageFeature: dataList.every((data) => data.usageFeature === dataList[0]!.usageFeature)
        ? dataList[0]!.usageFeature
        : "sharedRequests",
    },
    promptResolver,
    {
      isBatch: true,
      context,
      signal,
      glossaryTerms: mergeBatchGlossaryTerms(dataList),
      // The first member's template stands for the whole batch, which is sound
      // because `getBatchKey` keys on it: every member carries the same one.
      promptTemplate: dataList[0]!.promptTemplate,
    },
  )
  return parseBatchResult(result)
}

export type TranslateBatchData<TContext = unknown> = QueuedTranslationRouting & {
  text: string
  langConfig: Config["language"]
  hash: string
  scheduleAt: number
  context?: TContext
  // Resolved by the sender, where the page URL is known. A separate field from
  // `context` on purpose: `context` is part of the batch key.
  glossaryTerms?: readonly MatchedTerm[]
  // Which revision `glossaryTerms` was read from — how `mergeBatchGlossaryTerms`
  // settles two members that disagree about one term.
  glossaryRevision?: number
  // The raw prompt template the sender hashed `hash` over. Absent for a sender
  // that predates the field, whose prompt is resolved from storage at execution.
  promptTemplate?: PromptTemplate
  // Cancellation scope (`${tabId}:${sessionId}`); absent = uncancellable.
  scope?: string
  // The sender is a private-window tab. Part of the batch key, and the sender
  // also moves `hash` (the dedup key) into a private namespace — see
  // `getQueueIdentity` — so private and normal requests share neither a dedup
  // slot nor a provider request.
  privateSender?: boolean
}

/**
 * Compose the cancellation scope from the message sender and the content
 * script's session id. Building it background-side from `sender.tab.id` makes
 * cross-tab cancellation impossible by construction.
 */
export function buildTranslationScopeKey(
  sender: { tab?: { id?: number } } | undefined,
  sessionId: string | undefined,
): string | undefined {
  const tabId = sender?.tab?.id
  return typeof tabId === "number" && sessionId ? `${tabId}:${sessionId}` : undefined
}

interface TranslationQueueSetupConfig<TContext = unknown> {
  requestQueueConfig: RequestQueueConfig
  batchQueueConfig: BatchQueueConfig
  promptResolver: PromptResolver<TContext>
  // Present only for queues whose requests carry cancellation scopes.
  isScopeCancelled?: (scopeKey: string) => boolean
  queueName: "webpage" | "subtitles"
  // "default" means the user's stored config could not be loaded — the queue
  // is running on DEFAULT_CONFIG values (rate 8 / capacity 20), NOT what the
  // options page shows. Logged loudly so support reports are diagnosable.
  configSource: "user" | "default"
}

async function createTranslationQueues<TContext>(config: TranslationQueueSetupConfig<TContext>) {
  const { rate, capacity } = config.requestQueueConfig
  const { maxCharactersPerBatch, maxItemsPerBatch } = config.batchQueueConfig
  const { promptResolver, isScopeCancelled, queueName, configSource } = config

  logger.info(`[translation-queues] ${queueName} queue init`, {
    rate,
    capacity,
    maxCharactersPerBatch,
    maxItemsPerBatch,
    configSource,
  })
  if (configSource === "default") {
    logger.error(
      `[translation-queues] ${queueName} queue running on DEFAULT config (rate ${rate}, capacity ${capacity}) — user config unavailable at init`,
    )
  }

  const requestQueue = new RequestQueue({
    rate,
    capacity,
    timeoutMs: 20_000,
    maxRetries: 2,
    baseRetryDelayMs: 1_000,
  })
  const batchQueue = new BatchQueue<TranslateBatchData<TContext>, string>({
    maxCharactersPerBatch,
    maxItemsPerBatch,
    batchDelay: 100,
    maxRetries: 3,
    enableFallbackToIndividual: true,
    // Narrow port, not the whole queue: while the rate limiter has no free
    // slot, pending batches keep filling to maxItems/maxChars instead of
    // flushing tiny every batchDelay (they'd only freeze in the queue).
    dispatchGate: { nextDispatchEtaMs: () => requestQueue.nextDispatchEtaMs() },
    getBatchKey: (data) => {
      return Sha256Hex(
        `${data.langConfig.sourceCode}-${data.langConfig.targetCode}`,
        // executeBatchTranslation uses the first member's captured config for
        // every item. Match the full provider cache identity so edits to the
        // same ID cannot route another snapshot's text through that config.
        JSON.stringify(getLocalProviderConfig(data.provider)),
        data.context ? JSON.stringify(data.context) : "",
        // Not the terms — the REVISION. The terms differ per paragraph and
        // keying on them would end batching for glossary users; the revision is
        // one global counter that every paragraph of a page carries alike, so
        // this component is inert except across an edit. What it buys is that a
        // batch can only ever hold one glossary state, which is the only way to
        // represent a REMOVAL: see `mergeBatchGlossaryTerms`.
        `glossaryRevision:${data.glossaryRevision ?? 0}`,
        // The prompt the batch will run, so items hashed under different prompts
        // (the user switched mid-page, or A -> B -> A) never share one request:
        // `executeBatchTranslation` runs the first member's template for all of
        // them. Only the choice of prompt is keyed — the target language is
        // already above, and the terms and context are filled in per request.
        `promptTemplate:${data.promptTemplate ? JSON.stringify(data.promptTemplate) : ""}`,
        // Only a private item adds a component, so a normal item's key is
        // exactly what it was. Keeps a private tab's text out of any provider
        // request that also carries a normal tab's text.
        ...(data.privateSender ? ["privateSender"] : []),
      )
    },
    getCharacters: (data) => data.text.length,
    getDedupKey: (data) => data.hash,
    getScope: (data) => data.scope,
    isScopeCancelled,
    executeBatch: async (dataList, meta) => {
      const { provider } = dataList[0]!
      const hash = Sha256Hex(...dataList.map((d) => d.hash))
      const earliestScheduleAt = Math.min(...dataList.map((d) => d.scheduleAt))
      const totalCharacters = dataList.reduce((sum, d) => sum + d.text.length, 0)
      const timeoutMs = Math.min(
        BATCH_TIMEOUT_BASE_MS + totalCharacters * BATCH_TIMEOUT_PER_CHAR_MS,
        MAX_BATCH_TIMEOUT_MS,
      )

      const batchThunk = async (signal?: AbortSignal): Promise<string[]> => {
        const localProvider = getLocalProviderConfig(provider)
        if (localProvider) {
          await putBatchRequestRecord({
            originalRequestCount: dataList.length,
            providerConfig: localProvider,
          })
        }
        return await executeBatchTranslation(dataList, promptResolver, signal)
      }

      return requestQueue.enqueue(batchThunk, earliestScheduleAt, hash, meta.scopes, { timeoutMs })
    },
    executeIndividual: async (data, meta) => {
      const {
        text,
        langConfig,
        provider,
        hash,
        scheduleAt,
        context,
        glossaryTerms,
        promptTemplate,
      } = data
      const thunk = async (signal?: AbortSignal) => {
        const localProvider = getLocalProviderConfig(provider)
        if (localProvider) {
          await putBatchRequestRecord({ originalRequestCount: 1, providerConfig: localProvider })
        }
        return executeQueuedTranslation(text, langConfig, data, promptResolver, {
          context,
          signal,
          // The sender's own terms, NOT the batch union: this is one item again.
          // Dropping them here would let a batch that fell back translate
          // without the glossary and then cache that result under a hash taken
          // over a prompt that HAD the terms in it — a mismatch that outlives
          // the failure by a week.
          glossaryTerms,
          // Likewise the item's own prompt: a fallback must not re-resolve the
          // stored selection and cache that under the hash of another one.
          promptTemplate,
        })
      }
      // The owners of THIS item, not `data.scope`: that is only the first session that asked for
      // it, while later ones were deduped into the same item. Using it let the first session's
      // cancel abort a request another session was still waiting for (and left a first session that
      // had already cancelled as an owner nobody could cancel again).
      return requestQueue.enqueue(thunk, scheduleAt, hash, meta.scopes)
    },
    onError: (error, context) => {
      const errorType = context.isFallback ? "Individual request" : "Batch request"
      logger.error(
        `${errorType} failed (batchKey: ${context.batchKey}, retry: ${context.retryCount}):`,
        error.message,
      )
    },
  })

  return { requestQueue, batchQueue }
}

/**
 * Load the persisted config and build the queues. Never rejects: a broken
 * storage layer degrades to DEFAULT_CONFIG (loudly logged) instead of leaving
 * every translation message rejected.
 */
async function loadQueueSetupConfig(
  queueName: "webpage" | "subtitles",
  selectConfig: (config: Config) => {
    requestQueueConfig: RequestQueueConfig
    batchQueueConfig: BatchQueueConfig
  },
): Promise<{
  requestQueueConfig: RequestQueueConfig
  batchQueueConfig: BatchQueueConfig
  configSource: "user" | "default"
}> {
  let config: Config | null = null
  try {
    config = await ensureInitializedConfig()
  } catch (error) {
    logger.error(`[translation-queues] failed to load config for ${queueName} queue`, error)
  }
  return {
    ...selectConfig(config ?? DEFAULT_CONFIG),
    configSource: config ? "user" : "default",
  }
}

/**
 * Re-apply queue config from storage on every persisted change. This replaces
 * the per-field set*QueueConfig messages: those could be dropped while the SW
 * was cold-starting (handlers used to register only after awaits), silently
 * leaving the live queue on stale values.
 */
function watchQueueConfig(
  queueName: "webpage" | "subtitles",
  queuesPromise: Promise<{
    requestQueue: RequestQueue
    batchQueue: { setBatchConfig: (config: Partial<BatchQueueConfig>) => void }
  }>,
  selectConfig: (config: Config) => {
    requestQueueConfig: RequestQueueConfig
    batchQueueConfig: BatchQueueConfig
  },
) {
  let lastAppliedJson: string | null = null
  storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (newConfig) => {
    if (!newConfig) return
    void queuesPromise.then(({ requestQueue, batchQueue }) => {
      try {
        const selected = selectConfig(newConfig)
        const json = JSON.stringify(selected)
        if (json === lastAppliedJson) return
        requestQueue.setQueueOptions(selected.requestQueueConfig)
        batchQueue.setBatchConfig(selected.batchQueueConfig)
        lastAppliedJson = json
        logger.info(`[translation-queues] ${queueName} queue config updated`, selected)
      } catch (error) {
        logger.error(`[translation-queues] failed to apply ${queueName} queue config change`, error)
      }
    })
  })
}

const selectWebPageQueueConfig = (config: Config) => ({
  requestQueueConfig: config.pageTranslation.requestQueueConfig,
  batchQueueConfig: config.pageTranslation.batchQueueConfig,
})

export function createWebPageTranslationQueues() {
  // Scopes whose cancel already drained the queues. Consulted by (a) the
  // enqueue handler after its cache-lookup await and (b) the batch queue's
  // retry/fallback path after its backoff sleep — both are windows where a
  // request lives in NO cancellable structure, so a cancel arriving there
  // would otherwise be lost (#1881).
  const cancelledScopes = new CancelledScopeRegistry()

  const webPromptResolver: PromptResolver<WebPagePromptContext> = getTranslatePrompt

  const queuesPromise = loadQueueSetupConfig("webpage", selectWebPageQueueConfig).then(
    ({ requestQueueConfig, batchQueueConfig, configSource }) =>
      createTranslationQueues<WebPagePromptContext>({
        requestQueueConfig,
        batchQueueConfig,
        promptResolver: webPromptResolver,
        isScopeCancelled: (scopeKey) => cancelledScopes.has(scopeKey),
        queueName: "webpage",
        configSource,
      }),
  )

  watchQueueConfig("webpage", queuesPromise, selectWebPageQueueConfig)

  return { queuesPromise, cancelledScopes }
}

const selectSubtitlesQueueConfig = (config: Config) => ({
  requestQueueConfig: config.videoSubtitles.requestQueueConfig,
  batchQueueConfig: config.videoSubtitles.batchQueueConfig,
})

/**
 * Create subtitle translation queues and watch their configuration
 */
export function createSubtitlesTranslationQueues() {
  const queuesPromise = loadQueueSetupConfig("subtitles", selectSubtitlesQueueConfig).then(
    ({ requestQueueConfig, batchQueueConfig, configSource }) =>
      createTranslationQueues({
        requestQueueConfig,
        batchQueueConfig,
        promptResolver: getSubtitlesTranslatePrompt,
        queueName: "subtitles",
        configSource,
      }),
  )

  watchQueueConfig("subtitles", queuesPromise, selectSubtitlesQueueConfig)

  return queuesPromise
}
