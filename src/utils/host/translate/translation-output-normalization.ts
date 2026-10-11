import type { ProviderConfig } from "@/types/config/provider"
/** Retained providers return text verbatim; content rendering handles escaping. */
export function normalizeTranslationOutput(
  _providerConfig: Pick<ProviderConfig, "provider">,
  text: string,
): string {
  return text
}
