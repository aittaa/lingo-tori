import type { InlineAtomExtraction } from "../dom/inline-atoms"
import type { PageTranslationRequestOptions } from "../translate-variants"
import type { Config } from "@/types/config/config"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { TransNode } from "@/types/dom"
import { logger } from "@/utils/logger"
import { resolvePageTranslationProvider } from "@/utils/providers/provider-ref"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { getOwnerDocument } from "../../dom/node"
import { extractInlineAtomText, getInlineAtomSelector } from "../dom/inline-atoms"
import { protectTranslationHtmlAttributes } from "../dom/translation-html-attributes"
import { shouldFilterSmallParagraph } from "../filter-small-paragraph"
import { isHtmlAttributeMarkerIntegrityError } from "../html-attribute-markers"
import { shouldSkipAsTargetLanguage } from "../target-language-skip"
import { normalizeForComparison } from "../text-preparation"
import { translateTextForPage } from "../translate-variants"
import { getPageTranslationSessionId } from "../translation-session"
import { isNumericContent } from "../ui/translation-utils"

interface PageTranslationSource extends InlineAtomExtraction {
  nodes: readonly TransNode[]
}

interface PageTranslationRequest {
  sourceText: string
  textFormat: TranslationTextFormat
  translate: () => Promise<string>
  getDisplayText: (translatedText: string | undefined) => string | undefined
}

/** Both modes filter the same prose; code and formulas never affect eligibility. */
export function preparePageTranslationSource(
  nodes: readonly TransNode[],
  config: Config,
): PageTranslationSource | null {
  const extraction = extractInlineAtomText(nodes, config)
  const filterText = extraction.filterText.trim()
  if (!filterText || isNumericContent(filterText)) return null
  if (extraction.atoms.length > 0 && !extraction.hasProse) return null
  return { ...extraction, nodes, filterText, requestText: extraction.requestText.trim() }
}

/**
 * Run before either mode inserts its spinner; virtual paragraphs use this too.
 * Pass prose (`filterText`), never the HTML request: language detection on
 * markup is noise.
 */
export async function shouldSkipPageTranslationText(
  text: string,
  config: Config,
): Promise<boolean> {
  return (
    !text.trim() ||
    isNumericContent(text) ||
    (await shouldFilterSmallParagraph(text, config)) ||
    (await shouldSkipAsTargetLanguage(text, config))
  )
}

const unsupportedDeepLXHtmlAttributeProviders = new Set<string>()
const supportedDeepLXHtmlAttributeProviders = new Set<string>()
type DeepLXHtmlAttributeProbeResult = "supported" | "unsupported" | "unknown"
interface DeepLXHtmlAttributeProbe {
  promise: Promise<DeepLXHtmlAttributeProbeResult>
  resolve: (result: DeepLXHtmlAttributeProbeResult) => void
}
const deepLXHtmlAttributeProbes = new Map<string, DeepLXHtmlAttributeProbe>()

/**
 * The page-translation session that created a request, fixed when the request is created: a request
 * can wait (on the DeepLX capability probe, on its own first answer before a retry) and must not
 * take whichever session is current when it finally goes out.
 */
interface RequestOwner {
  sessionId: string | undefined
}

async function translateTextForAction(
  text: string,
  textFormat: "plain" | "html",
  owner: RequestOwner,
  forceRetranslation: boolean = false,
): Promise<string> {
  const currentSessionId = getPageTranslationSessionId() ?? undefined
  // The owner's session ended or was replaced while this request waited: it is cancelled like a
  // request the background drained, so nothing is sent unscoped or into the new session.
  if (owner.sessionId !== undefined && currentSessionId !== owner.sessionId) {
    throw new TranslationCancelledError(owner.sessionId)
  }
  // `translateTextForPage` reads the current session at its entry. That is the owner whenever the
  // owner is the current session, or there was none and there still is none; only a request created
  // with no session that a session has started under since must say it has none, or it would be
  // adopted by that session.
  return translateTextForPage(
    text,
    textFormat,
    owner.sessionId === undefined && currentSessionId !== undefined
      ? { forceRetranslation, sessionId: null }
      : { forceRetranslation },
  )
}

function createDeepLXHtmlAttributeProbe(): DeepLXHtmlAttributeProbe {
  let resolve!: (result: DeepLXHtmlAttributeProbeResult) => void
  const promise = new Promise<DeepLXHtmlAttributeProbeResult>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function finishDeepLXHtmlAttributeProbe(
  providerKey: string,
  probe: DeepLXHtmlAttributeProbe | undefined,
  result: DeepLXHtmlAttributeProbeResult,
): void {
  if (!probe || deepLXHtmlAttributeProbes.get(providerKey) !== probe) return
  deepLXHtmlAttributeProbes.delete(providerKey)
  probe.resolve(result)
}

async function acquireDeepLXHtmlAttributeProbe(providerKey: string): Promise<{
  probe?: DeepLXHtmlAttributeProbe
  useLegacy: boolean
}> {
  while (true) {
    if (unsupportedDeepLXHtmlAttributeProviders.has(providerKey)) {
      return { useLegacy: true }
    }
    if (supportedDeepLXHtmlAttributeProviders.has(providerKey)) {
      return { useLegacy: false }
    }

    const activeProbe = deepLXHtmlAttributeProbes.get(providerKey)
    if (!activeProbe) {
      const probe = createDeepLXHtmlAttributeProbe()
      deepLXHtmlAttributeProbes.set(providerKey, probe)
      return { probe, useLegacy: false }
    }

    // An empty/skipped request or a transient error proves neither support nor
    // incompatibility. Re-enter the loop so exactly one waiter owns the next probe.
    await activeProbe.promise
  }
}

function getDeepLXHtmlAttributeProviderKey(config: Config): string | undefined {
  const resolved = resolvePageTranslationProvider(config)
  if (resolved.config.provider !== "deeplx") {
    return undefined
  }
  return `${resolved.config.id}:${resolved.config.baseURL ?? ""}`
}

export function getDisplayTranslation(
  sourceText: string,
  translatedText: string | undefined,
  comparisonText: string | undefined = translatedText,
) {
  if (translatedText === undefined) {
    return undefined
  }

  // comparisonText lets the HTML-marker path (#1832) compare a normalized
  // variant while the raw translatedText is what gets displayed; the folding
  // normalization (#1835) applies on top for both paths.
  return normalizeForComparison(sourceText) === normalizeForComparison(comparisonText)
    ? ""
    : translatedText
}

/**
 * Shared request/response preparation, independent of how the result is displayed.
 * Plain requests keep Microsoft compatibility and clone atoms at token positions.
 * HTML requests retain the translation-only attribute/atom protection and fallback,
 * so the result can be aligned with the site's existing elements.
 */
export function createPageTranslationRequest(
  source: PageTranslationSource,
  config: Config,
  textFormat: TranslationTextFormat,
  options: PageTranslationRequestOptions,
): PageTranslationRequest {
  if (textFormat === "plain") {
    return {
      sourceText: source.requestText,
      textFormat,
      translate: () => translateTextForPage(source.requestText, textFormat, options),
      getDisplayText: (translatedText) => getDisplayTranslation(source.requestText, translatedText),
    }
  }

  const protectedHtml = protectTranslationHtmlAttributes(
    source.nodes,
    getOwnerDocument(source.nodes[0]!),
    getInlineAtomSelector(config),
  )
  // The source string mixes text nodes with element outerHTML and the result
  // is re-rendered via innerHTML, so providers must treat it as HTML to keep
  // its tags intact.
  const deepLXProviderKey = getDeepLXHtmlAttributeProviderKey(config)
  const owner: RequestOwner = { sessionId: getPageTranslationSessionId() ?? undefined }
  // Nothing in this paragraph needed protecting, so the page's own HTML holds nothing the protected
  // request would have kept local: it is the request.
  const translateLegacyHtml = async () => {
    const translatedHtml = await translateTextForAction(
      protectedHtml.legacyRequestHtml,
      "html",
      owner,
      options.forceRetranslation,
    )
    return translatedHtml ? protectedHtml.restoreLegacy(translatedHtml) : translatedHtml
  }
  // The request after a provider (or a remembered endpoint) could not keep the markers. It goes out
  // without them and without the attributes they stood for: asking again must not widen what leaves
  // the page. Its answer has no markers to restore from, so it is cut back to the readable attributes;
  // the page's own elements and attributes are not touched by it either way.
  const translateFallbackHtml = async () => {
    const translatedHtml = await translateTextForAction(
      protectedHtml.fallbackRequestHtml,
      "html",
      owner,
      options.forceRetranslation,
    )
    return translatedHtml ? protectedHtml.restoreFallback(translatedHtml) : translatedHtml
  }
  const translateRequest = async () => {
    if (!protectedHtml.hasPlaceholders) return translateLegacyHtml()

    let ownedDeepLXProbe: DeepLXHtmlAttributeProbe | undefined
    if (deepLXProviderKey) {
      const probeDecision = await acquireDeepLXHtmlAttributeProbe(deepLXProviderKey)
      if (probeDecision.useLegacy) return translateFallbackHtml()
      ownedDeepLXProbe = probeDecision.probe
    }

    try {
      const translatedHtml = await translateTextForAction(
        protectedHtml.requestHtml,
        "html",
        owner,
        options.forceRetranslation,
      )
      if (!translatedHtml) {
        if (deepLXProviderKey) {
          finishDeepLXHtmlAttributeProbe(deepLXProviderKey, ownedDeepLXProbe, "unknown")
        }
        return translatedHtml
      }

      const restoredHtml = protectedHtml.restore(translatedHtml)
      if (deepLXProviderKey) {
        supportedDeepLXHtmlAttributeProviders.add(deepLXProviderKey)
        finishDeepLXHtmlAttributeProbe(deepLXProviderKey, ownedDeepLXProbe, "supported")
      }
      return restoredHtml
    } catch (error) {
      if (!isHtmlAttributeMarkerIntegrityError(error)) {
        if (deepLXProviderKey) {
          finishDeepLXHtmlAttributeProbe(deepLXProviderKey, ownedDeepLXProbe, "unknown")
        }
        throw error
      }

      if (deepLXProviderKey) {
        unsupportedDeepLXHtmlAttributeProviders.add(deepLXProviderKey)
        supportedDeepLXHtmlAttributeProviders.delete(deepLXProviderKey)
        finishDeepLXHtmlAttributeProbe(deepLXProviderKey, ownedDeepLXProbe, "unsupported")
      }
      logger.warn(
        "HTML attribute placeholders were not preserved; retrying without the protected attributes",
        error,
      )
      return translateFallbackHtml()
    }
  }

  return {
    sourceText: protectedHtml.sourceHtml,
    textFormat,
    translate: translateRequest,
    getDisplayText: (translatedText) => {
      if (!translatedText) return translatedText
      // An answer that only repeats the source is no translation, whichever request it answers:
      // the protected one is compared with the page's HTML, the fallback one with its own request.
      const comparison = protectedHtml.normalizeForComparison(translatedText)
      return getDisplayTranslation(
        protectedHtml.comparisonSourceHtml,
        translatedText,
        comparison,
      ) === ""
        ? ""
        : getDisplayTranslation(
            protectedHtml.fallbackComparisonSourceHtml,
            translatedText,
            comparison,
          )
    },
  }
}
