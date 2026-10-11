import type { Config } from "@/types/config/config"
import { isTranslateProvider } from "@/types/config/provider"
/** All retained translation providers support markup-preserving page translation. */
export function providerSupportsTranslationOnlyMode(provider: string): boolean {
  return isTranslateProvider(provider)
}
export function getTranslationOnlyBlockedReason(_config: Config): string | null {
  return null
}
