import type { MatchedTerm } from "./types"
import type { LangCodeISO6393 } from "@/lib/languages"
import type { FeatureProviderAnalytics } from "@/types/analytics"

/** Compatibility boundary for translation callers. Telemetry is removed. */
export function trackGlossaryUsed(
  _feature: string,
  _terms: readonly MatchedTerm[],
  _targetLanguage: LangCodeISO6393,
  _provider?: FeatureProviderAnalytics,
): void {}
