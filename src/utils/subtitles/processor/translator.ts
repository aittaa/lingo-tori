import type { SubtitlesFragment } from "../types"
import type { Config } from "@/types/config/config"
import type { SubtitlePromptContext } from "@/types/content"
import type { MatchedTerm } from "@/utils/glossary/types"
import type { PromptableProviderRef, SerializableProviderRef } from "@/utils/providers/provider-ref"
import { APICallError } from "ai"
import { LANG_CODE_TO_EN_NAME } from "@/lib/languages"
import { isLLMProviderConfig } from "@/types/config/provider"
import { classifySerializedProvider } from "@/utils/analytics-provider"
import { getLocalConfig } from "@/utils/config/storage"
import { cleanText } from "@/utils/content/utils"
import { resolveGlossaryTerms } from "@/utils/glossary/active-matcher"
import { trackGlossaryUsed } from "@/utils/glossary/analytics"
import { Sha256Hex } from "@/utils/hash"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { normalizePromptContextValue } from "@/utils/host/translate/translate-text"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import {
  canResolvedProviderRefGenerateText,
  getProviderCacheIdentity,
  serializeProviderRef,
} from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"

/**
 * What the resolved provider is being asked to do. Line translation is the
 * capability the provider list is gated on, so any resolved provider can run
 * it; a summary or a recut is a generation, which only a promptable provider
 * can run — the resolution reports that as its own state instead of handing
 * out a ref the task can only throw on.
 */
export type SubtitlesTask = "lineTranslation" | "summary" | "segmentation"

function toFriendlyErrorMessage(error: unknown): string {
  if (error instanceof APICallError) {
    switch (error.statusCode) {
      case 429:
        return i18n.t("subtitles.errors.aiRateLimited")
      case 401:
      case 403:
        return i18n.t("subtitles.errors.aiAuthFailed")
      case 500:
      case 502:
      case 503:
        return i18n.t("subtitles.errors.aiServiceUnavailable")
      default:
        break
    }
  }

  const message = error instanceof Error ? error.message : String(error)

  if (message.includes("No Response") || message.includes("Empty response")) {
    return i18n.t("subtitles.errors.aiNoResponse")
  }

  return message
}

export interface SubtitlesVideoContext {
  videoTitle: string
  videoDescription?: string | null
  subtitlesTextContent: string
  summary?: string | null
}

export function buildSubtitlesSummaryContextHash(
  videoContext: Pick<SubtitlesVideoContext, "subtitlesTextContent">,
  providerRef?: SerializableProviderRef,
): string | undefined {
  const preparedText = cleanText(videoContext.subtitlesTextContent)
  if (!preparedText) {
    return undefined
  }

  const textHash = Sha256Hex(preparedText)
  return Sha256Hex(textHash, providerRef ? getProviderCacheIdentity(providerRef) : "")
}

function normalizeSubtitlePromptContext(
  videoContext: SubtitlesVideoContext,
): SubtitlePromptContext {
  return {
    webTitle: normalizePromptContextValue(videoContext.videoTitle),
    webDescription: normalizePromptContextValue(videoContext.videoDescription),
    videoSummary: normalizePromptContextValue(videoContext.summary),
  }
}

async function buildSubtitleHashComponents(
  text: string,
  providerRef: SerializableProviderRef,
  partialLangConfig: {
    sourceCode: Config["language"]["sourceCode"]
    targetCode: Config["language"]["targetCode"]
  },
  enableAIContentAware: boolean,
  subtitlePromptContext: SubtitlePromptContext,
  subtitlesTextContent: string,
  glossaryTerms: readonly MatchedTerm[],
): Promise<string[]> {
  const preparedText = prepareTranslationText(text)
  const normalizedSubtitlesTextContent = normalizePromptContextValue(subtitlesTextContent)
  const hashComponents = [
    preparedText,
    getProviderCacheIdentity(providerRef),
    partialLangConfig.sourceCode,
    partialLangConfig.targetCode,
  ]

  // Pure translate providers take no prompt; Built-in AI does, and so do local
  // LLMs, so both contribute the prompt to the cache key.
  if (providerRef.kind === "local" && !isLLMProviderConfig(providerRef.config)) {
    return hashComponents
  }

  const targetLangName = LANG_CODE_TO_EN_NAME[partialLangConfig.targetCode]
  const promptContext = enableAIContentAware
    ? subtitlePromptContext
    : { ...subtitlePromptContext, videoSummary: undefined }
  // Passed in rather than resolved here, so the prompt this hash is taken over
  // is built from exactly the terms the request will carry.
  const { systemPrompt, prompt } = await getSubtitlesTranslatePrompt(targetLangName, preparedText, {
    isBatch: true,
    context: promptContext,
    glossaryTerms,
  })
  hashComponents.push(systemPrompt, prompt)
  hashComponents.push(
    enableAIContentAware ? "enableAIContentAware=true" : "enableAIContentAware=false",
  )

  if (subtitlePromptContext.webTitle) {
    hashComponents.push(`webTitle:${subtitlePromptContext.webTitle}`)
  }
  if (subtitlePromptContext.webDescription) {
    hashComponents.push(`webDescription:${subtitlePromptContext.webDescription}`)
  }
  if (enableAIContentAware) {
    if (normalizedSubtitlesTextContent) {
      hashComponents.push(`subtitlesTextContent:${normalizedSubtitlesTextContent.slice(0, 1000)}`)
    }
    if (subtitlePromptContext.videoSummary) {
      hashComponents.push(`videoSummary:${subtitlePromptContext.videoSummary}`)
    }
  }

  return hashComponents
}

async function translateSingleSubtitle(
  text: string,
  langConfig: Config["language"],
  providerRef: SerializableProviderRef,
  enableAIContentAware: boolean,
  glossaryEnabled: boolean,
  videoContext: SubtitlesVideoContext,
): Promise<string> {
  const subtitlePromptContext = normalizeSubtitlePromptContext(videoContext)
  // Resolved once on the page, where the URL says which glossaries apply, and
  // then carried by the request — the background serves every tab at once.
  const { terms: glossaryTerms, revision: glossaryRevision } = await resolveGlossaryTerms(
    prepareTranslationText(text),
    glossaryEnabled,
    langConfig.targetCode,
  )
  trackGlossaryUsed(
    "videoSubtitles",
    glossaryTerms,
    langConfig.targetCode,
    classifySerializedProvider(providerRef),
  )
  const hashComponents = await buildSubtitleHashComponents(
    text,
    providerRef,
    { sourceCode: langConfig.sourceCode, targetCode: langConfig.targetCode },
    enableAIContentAware,
    subtitlePromptContext,
    videoContext.subtitlesTextContent,
    glossaryTerms,
  )

  if (enableAIContentAware) {
    const summary = subtitlePromptContext.videoSummary
    hashComponents.push(summary ? "subtitleSummary=ready" : "subtitleSummary=missing")
  }

  return await sendMessage("enqueueSubtitlesTranslateRequest", {
    text,
    langConfig,
    providerRef,
    scheduleAt: Date.now(),
    hash: Sha256Hex(...hashComponents),
    webTitle: subtitlePromptContext.webTitle,
    webDescription: subtitlePromptContext.webDescription,
    summary: enableAIContentAware ? subtitlePromptContext.videoSummary : undefined,
    glossaryTerms,
    glossaryRevision,
  })
}

export type SubtitlesProviderResolution<
  Ref extends SerializableProviderRef = SerializableProviderRef,
> = { status: "ok"; ref: Ref } | { status: "notPromptable" } | { status: "none" }

/** Reports without announcing, so callers can tell a plan/quota refusal from "nothing selected". */
export async function resolveSubtitlesProvider(
  config: Config,
  task: "lineTranslation",
): Promise<SubtitlesProviderResolution>
export async function resolveSubtitlesProvider(
  config: Config,
  task: "summary" | "segmentation",
): Promise<SubtitlesProviderResolution<PromptableProviderRef>>
export async function resolveSubtitlesProvider(
  config: Config,
  task: SubtitlesTask,
): Promise<SubtitlesProviderResolution>
export async function resolveSubtitlesProvider(
  config: Config,
  task: SubtitlesTask,
): Promise<SubtitlesProviderResolution> {
  const resolved = resolveProviderRefForCapability(
    "videoSubtitles",
    config.providersConfig,
    config.videoSubtitles.providerId,
  )
  if (!resolved) {
    return { status: "none" }
  }
  if (task !== "lineTranslation" && !canResolvedProviderRefGenerateText(resolved)) {
    return { status: "notPromptable" }
  }
  return { status: "ok", ref: await serializeProviderRef(resolved) }
}

/**
 * Resolve the subtitles provider into a transportable ref. Capability-based so
 * only the selected local provider can run a request.
 */
export async function resolveSubtitlesProviderRef(
  config: Config,
  task: "lineTranslation",
): Promise<SerializableProviderRef | null>
export async function resolveSubtitlesProviderRef(
  config: Config,
  task: "summary" | "segmentation",
): Promise<PromptableProviderRef | null>
export async function resolveSubtitlesProviderRef(
  config: Config,
  task: SubtitlesTask,
): Promise<SerializableProviderRef | null> {
  const resolution = await resolveSubtitlesProvider(config, task)
  return resolution.status === "ok" ? resolution.ref : null
}

export async function fetchSubtitlesSummary(
  videoContext: SubtitlesVideoContext,
  configOverride?: Config,
  providerRef?: PromptableProviderRef | null,
): Promise<string | null> {
  // Tri-state ref: a session that already resolved and narrowed its ref passes
  // it through — re-resolving could mint a different cache identity mid-session
  // within one session. `null` means the session
  // narrowed to "no promptable provider": skip outright, no message. Omitted
  // means "resolve here" (standalone callers).
  if (providerRef === null) {
    return null
  }

  const config = configOverride ?? (await getLocalConfig())
  if (!config?.pageTranslation.enableAIContentAware) {
    return null
  }

  const ref = providerRef ?? (await resolveSubtitlesProviderRef(config, "summary"))
  if (!ref) {
    return null
  }

  if (!videoContext.videoTitle || !videoContext.subtitlesTextContent) {
    return null
  }

  return await sendMessage("getSubtitlesSummary", {
    videoTitle: videoContext.videoTitle,
    subtitlesContext: videoContext.subtitlesTextContent,
    providerRef: ref,
  })
}

/**
 * `targetCode` pins the language of this batch and nothing else: the provider, glossary and the
 * rest still come from the settings as they stand, so a session can keep translating into the
 * language it was built for while those keep updating.
 */
export async function translateSubtitles(
  fragments: SubtitlesFragment[],
  videoContext: SubtitlesVideoContext,
  configOverride?: Config,
  targetCode?: Config["language"]["targetCode"],
): Promise<SubtitlesFragment[]> {
  const config = configOverride ?? (await getLocalConfig())
  if (!config) {
    return fragments.map((f) => ({ ...f, translation: "" }))
  }

  const providerRef = await resolveSubtitlesProviderRef(config, "lineTranslation")
  if (!providerRef) {
    return fragments.map((f) => ({ ...f, translation: "" }))
  }

  const langConfig = targetCode ? { ...config.language, targetCode } : config.language
  const enableAIContentAware = config.pageTranslation.enableAIContentAware

  const translationPromises = fragments.map((fragment) =>
    translateSingleSubtitle(
      fragment.text,
      langConfig,
      providerRef,
      enableAIContentAware,
      config.glossary.enabled,
      videoContext,
    ),
  )

  const results = await Promise.allSettled(translationPromises)

  // If all translations failed, throw with friendly error message
  const allRejected = results.every((r): r is PromiseRejectedResult => r.status === "rejected")
  if (allRejected && results.length) {
    throw new Error(toFriendlyErrorMessage(results[0]!.reason))
  }

  return fragments.map((fragment, index) => {
    const result = results[index]
    return {
      ...fragment,
      // A rejected request leaves the cue without a translation, set explicitly so an earlier one
      // on the fragment is not inherited. An empty string would read as translated-to-nothing and
      // be marked complete; a resolved empty translation still is.
      translation: result!.status === "fulfilled" ? result!.value : undefined,
    }
  })
}
