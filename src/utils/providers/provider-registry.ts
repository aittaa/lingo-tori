import type { ProviderSelectorOption } from "./provider-display"
import type { ProviderConfig, ProvidersConfig } from "@/types/config/provider"
import type { FeatureKey } from "@/utils/constants/feature-providers"
import { isLLMProviderConfig, isTranslateProviderConfig } from "@/types/config/provider"
export type ProviderCapability =
  | Exclude<FeatureKey, "inputTranslation">
  | "customAction"
  | "languageDetection"
type ProviderConfigPredicate<T extends ProviderConfig = ProviderConfig> = (
  provider: ProviderConfig,
) => provider is T
export interface LocalProviderRef<T extends ProviderConfig = ProviderConfig> {
  kind: "local"
  config: T
  id: string
  name: string
}
export type ResolvedProviderRef<T extends ProviderConfig = ProviderConfig> = LocalProviderRef<T>
const LOCAL_PROVIDER_CAPABILITY_PREDICATES = {
  pageTranslation: isTranslateProviderConfig,
  videoSubtitles: isTranslateProviderConfig,
  selectionTranslation: isTranslateProviderConfig,
  noteSuggestion: isLLMProviderConfig,
  customAction: isLLMProviderConfig,
  languageDetection: isLLMProviderConfig,
} as const satisfies Record<ProviderCapability, ProviderConfigPredicate>

export type ProviderConfigForCapability<C extends ProviderCapability> =
  (typeof LOCAL_PROVIDER_CAPABILITY_PREDICATES)[C] extends ProviderConfigPredicate<infer T>
    ? T
    : never

export type ProviderRefForCapability<C extends ProviderCapability> = ResolvedProviderRef<
  ProviderConfigForCapability<C>
>

export type CustomActionProviderRef = ProviderRefForCapability<"customAction">
export type SelectionTranslationProviderRef = ProviderRefForCapability<"selectionTranslation">

export function getLocalProviderPredicateForCapability<C extends ProviderCapability>(
  capability: C,
): ProviderConfigPredicate<ProviderConfigForCapability<C>> {
  return LOCAL_PROVIDER_CAPABILITY_PREDICATES[capability] as ProviderConfigPredicate<
    ProviderConfigForCapability<C>
  >
}

export function isLocalProviderConfigCompatibleWithCapability<C extends ProviderCapability>(
  capability: C,
  providerConfig: ProviderConfig,
): providerConfig is ProviderConfigForCapability<C> {
  return getLocalProviderPredicateForCapability(capability)(providerConfig)
}

export function doesProviderSupportsCapability(
  capability: ProviderCapability,
  providersConfig: ProvidersConfig,
  providerId: string,
  options: { requireEnable?: boolean } = {},
): boolean {
  const providerConfig = providersConfig.find((provider) => provider.id === providerId)
  if (providerConfig) {
    return (
      (!options.requireEnable || providerConfig.enabled) &&
      isLocalProviderConfigCompatibleWithCapability(capability, providerConfig)
    )
  }

  return false
}

export function getProviderIdsForCapability(
  capability: ProviderCapability,
  providersConfig: ProvidersConfig,
  options: { requireEnable?: boolean } = {},
): string[] {
  const localIds = providersConfig
    .filter(
      (provider) =>
        (!options.requireEnable || provider.enabled) &&
        isLocalProviderConfigCompatibleWithCapability(capability, provider),
    )
    .map((provider) => provider.id)

  return localIds
}

export function getSelectableProvidersForCapability(
  capability: ProviderCapability,
  providersConfig: ProvidersConfig,
): ProviderSelectorOption[] {
  const localProviders = providersConfig.filter(
    (provider) =>
      provider.enabled && isLocalProviderConfigCompatibleWithCapability(capability, provider),
  )

  return localProviders
}

export function resolveProviderRefForCapability<C extends ProviderCapability>(
  capability: C,
  providersConfig: ProvidersConfig,
  providerId: string,
): ProviderRefForCapability<C> | null {
  const providerConfig = providersConfig.find((provider) => provider.id === providerId)
  if (providerConfig) {
    if (
      !providerConfig.enabled ||
      !isLocalProviderConfigCompatibleWithCapability(capability, providerConfig)
    ) {
      return null
    }

    return {
      kind: "local",
      config: providerConfig,
      id: providerConfig.id,
      name: providerConfig.name,
    }
  }

  return null
}
