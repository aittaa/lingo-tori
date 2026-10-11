import type { ResolvedProviderRef } from "./provider-registry"
import type { Config } from "@/types/config/config"
import type { LLMProviderConfig, TranslateProviderConfig } from "@/types/config/provider"
import { isLLMProviderConfig } from "@/types/config/provider"
import { resolveProviderRefForCapability } from "./provider-registry"
import { ProviderSetupError } from "./provider-setup-error"
export type SerializableProviderRef = { kind: "local"; config: TranslateProviderConfig }
export type PromptableProviderRef = { kind: "local"; config: LLMProviderConfig }
export function resolvePageTranslationProvider(
  config: Config,
): ResolvedProviderRef<TranslateProviderConfig> {
  const ref = resolvePageTranslationProviderOrNull(config)
  if (!ref) throw new ProviderSetupError("Choose and configure a translation provider in Settings.")
  return ref
}
export function resolvePageTranslationProviderOrNull(
  config: Config,
): ResolvedProviderRef<TranslateProviderConfig> | null {
  return resolveProviderRefForCapability(
    "pageTranslation",
    config.providersConfig,
    config.pageTranslation.providerId,
  )
}
export function getProviderCacheIdentity(ref: SerializableProviderRef): string {
  return JSON.stringify(ref.config)
}
export function canProviderRefGenerateText(
  ref: SerializableProviderRef,
): ref is PromptableProviderRef {
  return isLLMProviderConfig(ref.config)
}
export function canResolvedProviderRefGenerateText(
  ref: ResolvedProviderRef,
): ref is ResolvedProviderRef<LLMProviderConfig> {
  return isLLMProviderConfig(ref.config)
}
export async function serializeProviderRef<T extends TranslateProviderConfig>(
  provider: ResolvedProviderRef<T>,
  _route?: string,
): Promise<{ kind: "local"; config: T }> {
  return { kind: "local", config: provider.config }
}
export type ProviderAvailability<Ref extends SerializableProviderRef = SerializableProviderRef> =
  | { available: true; providerRef: Ref }
  | { available: false; message: string }
export async function checkProviderAvailability<T extends TranslateProviderConfig>(
  provider: ResolvedProviderRef<T>,
  route?: string,
): Promise<ProviderAvailability<{ kind: "local"; config: T }>> {
  return { available: true, providerRef: await serializeProviderRef(provider, route) }
}
