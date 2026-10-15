import type { LangCodeISO6393, LangLevel } from "@/lib/languages"
import type { Config } from "@/types/config/config"
import type { TranslateProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { WebPagePromptContext } from "@/types/content"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { PromptTemplate } from "@/utils/prompts/template"
import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import type { ResolvedProviderRef } from "@/utils/providers/provider-registry"
import { toastManager } from "@/components/ui/base-ui/toast"
import { LANG_CODE_TO_EN_NAME } from "@/lib/languages"
import { isAPIProviderConfig, isLLMProviderConfig } from "@/types/config/provider"
import { isNoTranslationSentinel } from "@/utils/constants/prompt"
import { detectLanguage } from "@/utils/content/language"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { buildFeatureProviderRoute, getFeatureProviderRowId } from "@/utils/navigation"
import { getTranslatePrompt, getTranslatePromptTemplate } from "@/utils/prompts/translate"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { Sha256Hex } from "../../hash"
import { sendMessage } from "../../message"
import { getInMemoryTranslation, storeInMemoryTranslation } from "./in-memory-translation-cache"
import { isInlineAtomResultCacheable } from "./inline-atom-tokens"
import { prepareTranslationText } from "./text-preparation"
import { getPageTranslationSessionId } from "./translation-session"

/**
 * Minimum text length before a skip decision is attempted at all. Deliberately
 * below the general threshold, to catch short phrases like "Bonjour!" or
 * "こんにちは".
 *
 * Left at 10 even though detection is now franc-only. Raising it looks right
 * for Latin script — franc on ten characters is close to a coin flip there —
 * but this counts characters, and ten characters of Han, kana or Hangul is
 * plenty for franc precisely because the script alone is near-decisive. A flat
 * character count cannot express that difference, so tuning it needs a
 * script-aware rule rather than a bigger number.
 */
export const MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION = 10

/**
 * Check if text should be skipped based on language detection.
 *
 * Deliberately franc-only. This runs once per paragraph, so routing it through
 * an LLM costs one provider call per paragraph — hundreds per article, against
 * a user's own budget. The whole-page source language is detected once and
 * cached; this second, uncached, per-paragraph pass existed only for pages that
 * mix languages, and the value of a right answer here (avoid one redundant
 * translation) never justified the per-paragraph price of getting it.
 *
 * `languageDetection.mode` still governs the once-per-page source detection,
 * where a wrong answer corrupts the prompt for every paragraph.
 */
export async function shouldSkipByLanguage(
  text: string,
  skipLanguages: LangCodeISO6393[],
): Promise<boolean> {
  const detectedLang = await detectLanguage(text, {
    minLength: MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
    enableLLM: false,
  })

  if (!detectedLang) {
    return false
  }

  return skipLanguages.includes(detectedLang)
}

export function normalizePromptContextValue(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined) {
    return value
  }
  return value.trim() === "" ? null : value
}

function normalizeWebPagePromptContext(
  webPageContext?: WebPagePromptContext,
): WebPagePromptContext | undefined {
  if (!webPageContext) {
    return undefined
  }

  return {
    webTitle: normalizePromptContextValue(webPageContext.webTitle),
    webDescription: normalizePromptContextValue(webPageContext.webDescription),
    webContent: normalizePromptContextValue(webPageContext.webContent),
    webSummary: normalizePromptContextValue(webPageContext.webSummary),
  }
}

/**
 * Whether a request to this provider carries a prompt at all. Pure translate
 * APIs take none, so they contribute no prompt to the cache key and hold no
 * template snapshot.
 */
function providerTakesPrompt(providerRef: SerializableProviderRef): boolean {
  return !providerRef.config || isLLMProviderConfig(providerRef.config)
}

async function buildWebPageHashComponents(
  text: string,
  providerRef: SerializableProviderRef,
  partialLangConfig: { sourceCode: LangCodeISO6393 | "auto"; targetCode: LangCodeISO6393 },
  enableAIContentAware: boolean,
  textFormat: TranslationTextFormat,
  preserveLineBreaks: boolean,
  glossaryTerms: readonly MatchedTerm[],
  promptTemplate: PromptTemplate | undefined,
  webPageContext?: WebPagePromptContext,
): Promise<string[]> {
  const preparedText = prepareTranslationText(text)
  const normalizedWebPageContext = normalizeWebPagePromptContext(webPageContext)
  const providerHashIdentity = providerRef.config
  const hashComponents = [
    preparedText,
    JSON.stringify(providerHashIdentity),
    partialLangConfig.sourceCode,
    partialLangConfig.targetCode,
  ]

  if (!providerTakesPrompt(providerRef)) {
    // The provider request depends on the text format (escaping / textType), so
    // cache entries must too. This component also orphans entries cached before
    // the format-aware pipeline existed, which could hold corrupted output.
    hashComponents.push(`textFormat:${textFormat}`)
    return hashComponents
  }

  const targetLangName = LANG_CODE_TO_EN_NAME[partialLangConfig.targetCode]
  // The terms and the template are passed in rather than resolved here, so the
  // prompt this hash is taken over is built from exactly the terms and the
  // template the request will carry.
  const { systemPrompt, prompt } = await getTranslatePrompt(targetLangName, preparedText, {
    isBatch: true,
    context: normalizedWebPageContext,
    glossaryTerms,
    promptTemplate,
  })
  hashComponents.push(systemPrompt, prompt)
  hashComponents.push(
    enableAIContentAware ? "enableAIContentAware=true" : "enableAIContentAware=false",
  )

  if (enableAIContentAware && normalizedWebPageContext) {
    if (normalizedWebPageContext.webTitle) {
      hashComponents.push(`webTitle:${normalizedWebPageContext.webTitle}`)
    }
    if (normalizedWebPageContext.webDescription) {
      hashComponents.push(`webDescription:${normalizedWebPageContext.webDescription}`)
    }
    if (normalizedWebPageContext.webContent) {
      // Use a substring hash to avoid huge hash inputs while still differentiating contexts.
      hashComponents.push(`webContent:${normalizedWebPageContext.webContent.slice(0, 1000)}`)
    }
    if (normalizedWebPageContext.webSummary) {
      hashComponents.push(`webSummary:${normalizedWebPageContext.webSummary}`)
    }
  }

  return hashComponents
}

/** Snapshot the configured provider without network access. */
export async function resolvePageProviderRef<T extends TranslateProviderConfig>(
  provider: ResolvedProviderRef<T>,
  _sessionId?: string,
): Promise<{ kind: "local"; config: T }> {
  return serializeProviderRef(provider)
}

export interface TranslateTextOptions {
  usageFeature?: ApiUsageFeature
  text: string
  langConfig: {
    sourceCode: LangCodeISO6393 | "auto"
    targetCode: LangCodeISO6393
    level: LangLevel
  }
  providerConfig: ResolvedProviderRef<TranslateProviderConfig>
  enableAIContentAware?: boolean
  extraHashTags?: string[]
  webPageContext?: WebPagePromptContext
  textFormat?: TranslationTextFormat
  // Source line breaks are semantic — see the enqueueTranslateRequest field.
  preserveLineBreaks?: boolean
  // Page-translation session id used for cancellation scoping. Deliberately
  // NOT part of the cache hash — cache identity must not vary per session.
  sessionId?: string
  forceRetranslation?: boolean
  /**
   * Whether the user's glossary is switched on. Supplied by the caller, which
   * already holds the config, rather than re-read here per paragraph — the same
   * arrangement as `enableAIContentAware`.
   */
  glossaryEnabled?: boolean
}

/**
 * Core translation function — pure, zero config fetching.
 * All dependencies must be provided explicitly.
 */
export async function translateTextCore(options: TranslateTextOptions): Promise<string> {
  const {
    text,
    langConfig,
    providerConfig,
    enableAIContentAware = false,
    extraHashTags = [],
    usageFeature = "pageTranslation",
    webPageContext,
    textFormat = "plain",
    preserveLineBreaks = false,
    sessionId,
    forceRetranslation = false,
    glossaryEnabled = false,
  } = options

  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  // Early cancellation gate: a session stopped while this paragraph was still
  // preparing must not dispatch a provider request after cancellation.
  if (sessionId !== undefined && getPageTranslationSessionId() !== sessionId) {
    throw new TranslationCancelledError(sessionId)
  }

  const normalizedWebPageContext = normalizeWebPagePromptContext(webPageContext)
  const providerRef = await resolvePageProviderRef(providerConfig, sessionId)

  // Resolved ONCE, here, where `location.href` says which glossaries apply.
  // The same list feeds the cache hash and travels with the request, so the
  // prompt the hash describes is the prompt the background builds — it serves
  // every tab at once and could not scope this by itself.
  //
  // The revision travels with it because a batch can hold paragraphs resolved
  // either side of an edit made while this page was still translating, and it
  // is the only thing that tells the background which wording is the newer one
  // (see `mergeBatchGlossaryTerms`).
  const { terms: glossaryTerms, revision: glossaryRevision } = await resolveGlossaryTerms(
    preparedText,
    glossaryEnabled,
    langConfig.targetCode,
  )
  // Snapshotted ONCE per request, at the moment its cache key is hashed. The
  // request then carries the template, so the prompt that runs is the one this
  // hash describes even if the user switches prompts while the request waits in
  // a queue (an A -> B -> A switch would otherwise cache B's output under A's
  // key). Only the choice of prompt is frozen; the target language, context and
  // glossary terms are filled in from the request itself.
  const promptTemplate = providerTakesPrompt(providerRef)
    ? await getTranslatePromptTemplate()
    : undefined
  const hashComponents = await buildWebPageHashComponents(
    preparedText,
    providerRef,
    { sourceCode: langConfig.sourceCode, targetCode: langConfig.targetCode },
    enableAIContentAware,
    textFormat,
    preserveLineBreaks,
    glossaryTerms,
    promptTemplate,
    normalizedWebPageContext,
  )

  // Add extra hash tags for cache differentiation
  hashComponents.push(...extraHashTags)

  // Final gate before dispatch: if the page-translation session that owned
  // this request has ended (or been replaced) while we were preparing it,
  // abort instead of enqueueing. Sending now would either be unscoped (if the
  // id had gone null) or re-populate the queue AFTER the session's cancel
  // message already drained it — both defeat cancellation (#1881). Callers on
  // the page path swallow this error; input/selection requests carry no
  // sessionId and skip the gate entirely. The gate must also precede the
  // memory-tier read below: a cancelled session must not keep painting
  // translations out of memory.
  if (sessionId !== undefined && getPageTranslationSessionId() !== sessionId) {
    throw new TranslationCancelledError(sessionId)
  }

  const hash = Sha256Hex(...hashComponents)

  // In-tab memory tier over the background cache, same hash identity.
  // Virtualized pages (X articles/timelines) destroy and recreate paragraph
  // nodes on scroll; the recreated nodes re-enter this pipeline for text the
  // tab already translated, and paying the message round trip again makes the
  // page visibly re-translate paragraph by paragraph. Scoped to
  // page-translation runs (sessionId) so input/selection behavior is
  // untouched; forceRetranslation bypasses the read exactly like it bypasses
  // the background cache, but its fresh result still lands in the store below.
  if (sessionId !== undefined && !forceRetranslation) {
    const memoryHit = getInMemoryTranslation(hash)
    if (memoryHit !== undefined) {
      return isNoTranslationSentinel(memoryHit) ? "" : memoryHit
    }
  }

  const result = await sendMessage("enqueueTranslateRequest", {
    text: preparedText,
    usageFeature,
    langConfig,
    providerRef,
    scheduleAt: Date.now(),
    hash,
    textFormat,
    preserveLineBreaks,
    webTitle: normalizedWebPageContext?.webTitle,
    webDescription: normalizedWebPageContext?.webDescription,
    webContent: normalizedWebPageContext?.webContent,
    webSummary: normalizedWebPageContext?.webSummary,
    sessionId,
    forceRetranslation,
    glossaryTerms,
    glossaryRevision,
    promptTemplate,
  })
  // Raw result, sentinel included, so a "no translation needed" verdict is
  // remembered too; the mapping below stays the single mapping point. A result
  // whose inline-atom placeholders were dropped, duplicated or invented is shown
  // but not remembered — the background does not persist it either — so the next
  // request for the same text asks the provider again.
  if (sessionId !== undefined && isInlineAtomResultCacheable(preparedText, result)) {
    storeInMemoryTranslation(hash, result)
  }
  // The sentinel must be mapped here and only here: every batch-pipeline
  // consumer (page paragraphs, document title, input translation, selection
  // toolbar standard path) routes through this function and already handles
  // "" gracefully. Mapping earlier — in the background — would fall out of
  // the truthy-only cache write and re-hit the provider on every request.
  return isNoTranslationSentinel(result) ? "" : result
}

/** Stable, so a repeated attempt refreshes one toast instead of stacking another. */
const PROVIDER_REQUIRED_TOAST_ID = "read-frog-page-translation-provider-required"

export interface ValidateTranslationConfigOptions {
  /**
   * Say so when page translation has no provider of its own. Only for a start or a click the
   * user made: automatic, restored and per-frame starts stay quiet.
   */
  notifyMissingProvider?: boolean
}

function showProviderRequiredToast(): void {
  toastManager.add({
    id: PROVIDER_REQUIRED_TOAST_ID,
    type: "error",
    title: i18n.t("providerRequired.message"),
    // Nothing opens by itself: the settings page is only reached by pressing this.
    actionProps: {
      children: i18n.t("providerRequired.openSettings"),
      onClick: () => {
        toastManager.close(PROVIDER_REQUIRED_TOAST_ID)
        // Content scripts cannot use chrome.tabs, so go through the background.
        void sendMessage("openOptionsPage", {
          route: buildFeatureProviderRoute(getFeatureProviderRowId("pageTranslation")),
        })
      },
    },
  })
}

/**
 * API providers a page can translate with while the key field is empty. DeepLX and Ollama have
 * always been allowed. The custom OpenAI-compatible and Open Responses rows point at a server of
 * the user's own, which `getLanguageModelForConfig` already builds without asking for a key: a
 * local model server may authenticate some other way, or not at all. Hosted services — including
 * the ones that speak those protocols, like OpenRouter — still need one.
 */
const API_KEY_OPTIONAL_PROVIDERS: readonly string[] = [
  "deeplx",
  "ollama",
  "openai-compatible",
  "open-responses",
]

export function validateTranslationConfigAndToast(
  config: Pick<Config, "providersConfig" | "pageTranslation" | "language">,
  options: ValidateTranslationConfigOptions = {},
): boolean {
  const { providersConfig, pageTranslation: translateConfig, language: languageConfig } = config
  const provider = resolveProviderRefForCapability(
    "pageTranslation",
    providersConfig,
    translateConfig.providerId,
  )
  if (!provider) {
    if (options.notifyMissingProvider) {
      showProviderRequiredToast()
    }
    return false
  }

  if (languageConfig.sourceCode === languageConfig.targetCode) {
    toastManager.add({ type: "error", title: i18n.t("translation.sameLanguage") })
    logger.info("validateTranslationConfig: returning false (same language)")
    return false
  }

  // check if the API key is configured
  if (
    provider.kind === "local" &&
    isAPIProviderConfig(provider.config) &&
    !provider.config.apiKey?.trim() &&
    !API_KEY_OPTIONAL_PROVIDERS.includes(provider.config.provider)
  ) {
    toastManager.add({ type: "error", title: i18n.t("noAPIKeyConfig.warning") })
    logger.info("validateTranslationConfig: returning false (no API key)")
    return false
  }

  return true
}
