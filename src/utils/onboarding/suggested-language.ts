import type { LangCodeISO6393 } from "@/lib/languages"
import { LANG_CODE_ISO6393_OPTIONS, LOCALE_TO_ISO6393 } from "@/lib/languages"
import { DEFAULT_CONFIG } from "@/utils/constants/config"

// Regions written in Traditional Chinese; every other zh-* is Simplified.
const TRADITIONAL_CHINESE_REGIONS = new Set(["tw", "hk", "mo"])

const ISO6393_BY_LOWERCASE = new Map(
  LANG_CODE_ISO6393_OPTIONS.map((code) => [code.toLowerCase(), code] as const),
)

const CODE_BY_LOWERCASE_LOCALE = new Map(
  Object.entries(LOCALE_TO_ISO6393).flatMap(([locale, code]) =>
    code ? [[locale.toLowerCase(), code] as const] : [],
  ),
)

/**
 * The language a browser locale tag ("ko-KR", "pt_BR", "zh-Hant-TW") points at, as one of the
 * codes the language picker offers; null when the tag names none of them.
 */
export function suggestTargetCodeFromBrowserLocale(
  locale: string | null | undefined,
): LangCodeISO6393 | null {
  const tag = locale?.trim().replaceAll("_", "-").toLowerCase()
  if (!tag) return null

  const [primary = "", ...subtags] = tag.split("-")
  if (primary === "zh") {
    if (subtags.includes("yue")) return "yue"
    // An explicit script outranks the region: zh-Hans-TW is still Simplified.
    if (subtags.includes("hans")) return "cmn"
    if (subtags.includes("hant") || subtags.some((part) => TRADITIONAL_CHINESE_REGIONS.has(part))) {
      return "cmn-Hant"
    }
    return "cmn"
  }

  return (
    ISO6393_BY_LOWERCASE.get(tag) ??
    CODE_BY_LOWERCASE_LOCALE.get(tag) ??
    CODE_BY_LOWERCASE_LOCALE.get(primary) ??
    ISO6393_BY_LOWERCASE.get(primary) ??
    null
  )
}

export interface InitialTargetChoice {
  targetCode: LangCodeISO6393
  /** The pick comes from the browser language, so the page says so. */
  fromBrowserLanguage: boolean
}

/**
 * What the question opens on. A target that already differs from the shipped default is somebody's
 * choice — made in settings, or saved by an earlier attempt at this very question — and stays;
 * only the untouched default gives way to the browser's language. Either way nothing is saved
 * until the person confirms.
 */
export function pickInitialTargetChoice({
  currentTargetCode,
  browserLocale,
}: {
  currentTargetCode: LangCodeISO6393
  browserLocale: string | null | undefined
}): InitialTargetChoice {
  if (currentTargetCode !== DEFAULT_CONFIG.language.targetCode) {
    return { targetCode: currentTargetCode, fromBrowserLanguage: false }
  }
  const suggested = suggestTargetCodeFromBrowserLocale(browserLocale)
  return suggested
    ? { targetCode: suggested, fromBrowserLanguage: true }
    : { targetCode: currentTargetCode, fromBrowserLanguage: false }
}
