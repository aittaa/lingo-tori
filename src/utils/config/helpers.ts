import type { Config } from "@/types/config/config"
import type { LanguageDetectionMode } from "@/types/config/language-detection"
import type {
  APIProviderConfig,
  LLMProviderConfig,
  NonAPIProviderConfig,
  ProviderConfig,
  ProvidersConfig,
  PureAPIProviderConfig,
  TranslateProviderConfig,
} from "@/types/config/provider"
import type { FeatureKey } from "@/utils/constants/feature-providers"
import {
  isAPIProviderConfig,
  isLLMProviderConfig,
  isNonAPIProviderConfig,
  isPureAPIProviderConfig,
  isTranslateProviderConfig,
} from "@/types/config/provider"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { getSelectionToolbarActions, patchSelectionToolbarAction } from "@/utils/custom-actions"
import { getUsableProviderIdsForCapability } from "@/utils/providers/provider-availability"

export function getProviderConfigById<T extends ProviderConfig>(
  providersConfig: T[],
  providerId: string,
): T | undefined {
  return providersConfig.find((p) => p.id === providerId)
}

export function getLLMProvidersConfig(providersConfig: ProvidersConfig): LLMProviderConfig[] {
  return providersConfig.filter(isLLMProviderConfig)
}

export function getAPIProvidersConfig(providersConfig: ProvidersConfig): APIProviderConfig[] {
  return providersConfig.filter(isAPIProviderConfig)
}

export function getPureAPIProvidersConfig(
  providersConfig: ProvidersConfig,
): PureAPIProviderConfig[] {
  return providersConfig.filter(isPureAPIProviderConfig)
}

export function getNonAPIProvidersConfig(providersConfig: ProvidersConfig): NonAPIProviderConfig[] {
  return providersConfig.filter(isNonAPIProviderConfig)
}

export function getTranslateProvidersConfig(
  providersConfig: ProvidersConfig,
): TranslateProviderConfig[] {
  return providersConfig.filter(isTranslateProviderConfig)
}

export function filterEnabledProvidersConfig(providersConfig: ProvidersConfig): ProvidersConfig {
  return providersConfig.filter((p) => p.enabled)
}

export function getEnabledLLMProvidersConfig(
  providersConfig: ProvidersConfig,
): LLMProviderConfig[] {
  return filterEnabledProvidersConfig(providersConfig).filter(isLLMProviderConfig)
}

export function getProviderKeyByName(
  providersConfig: ProvidersConfig,
  providerId: string,
): string | undefined {
  const provider = getProviderConfigById(providersConfig, providerId)
  return provider?.provider
}

export function getProviderModelConfig(config: Config, providerId: string) {
  const providerConfig = getProviderConfigById(config.providersConfig, providerId)
  if (providerConfig && isLLMProviderConfig(providerConfig)) {
    return providerConfig.model
  }
  return undefined
}

export function getProviderApiKey(
  providersConfig: ProvidersConfig,
  providerId: string,
): string | undefined {
  const providerConfig = getProviderConfigById(providersConfig, providerId)
  if (providerConfig && isAPIProviderConfig(providerConfig)) {
    return providerConfig.apiKey
  }
  return undefined
}

export function resolveLanguageDetectionConfigForModeChange(
  currentConfig: Config["languageDetection"],
  nextMode: LanguageDetectionMode,
  providersConfig: ProvidersConfig,
): Partial<Config["languageDetection"]> | null {
  if (nextMode === "basic") {
    return { mode: "basic" }
  }

  const availableIds = getUsableProviderIdsForCapability("languageDetection", providersConfig)
  if (availableIds.length === 0) {
    return null
  }

  const hasSelectedProvider =
    currentConfig.providerId !== undefined && availableIds.includes(currentConfig.providerId)
  return {
    mode: "llm",
    providerId: hasSelectedProvider ? currentConfig.providerId : availableIds[0]!,
  }
}

export function computeProviderFallbacksAfterDeletion(
  deletedProviderId: string,
  config: Config,
  remainingProviders: ProvidersConfig,
): Partial<Record<FeatureKey, string>> {
  const updates: Partial<Record<FeatureKey, string>> = {}
  for (const key of FEATURE_KEYS) {
    const def = FEATURE_PROVIDER_DEFS[key]
    const currentId = def.getProviderId(config)
    if (currentId !== deletedProviderId) continue
    const fallbackProviderId = getUsableProviderIdsForCapability(key, remainingProviders)[0]
    updates[key] = fallbackProviderId ?? "unconfigured"
  }
  return updates
}

// An empty provider list is a valid local-only configuration.
export function findFeatureMissingProvider(
  _remainingProviders: ProvidersConfig,
  _config?: Config,
): FeatureKey | "languageDetection" | null {
  return null
}

export function computeSelectionToolbarCustomActionFallbacksAfterDeletion(
  deletedProviderId: string,
  config: Config,
  remainingProviders: ProvidersConfig,
): Config["selectionToolbar"] | null {
  const affectedActions = getSelectionToolbarActions(config.selectionToolbar).filter(
    (action) => action.providerId === deletedProviderId,
  )

  if (affectedActions.length === 0) {
    return null
  }

  const fallbackProviderId =
    getUsableProviderIdsForCapability("customAction", remainingProviders)[0] ?? "unconfigured"

  return affectedActions.reduce(
    (selectionToolbar, action) =>
      patchSelectionToolbarAction(selectionToolbar, action.id, {
        providerId: fallbackProviderId,
      }),
    config.selectionToolbar,
  )
}

export function computeLanguageDetectionFallbackAfterDeletion(
  deletedProviderId: string,
  config: Config,
  remainingProviders: ProvidersConfig,
): string | undefined | null {
  if (config.languageDetection.mode !== "llm") return null
  if (config.languageDetection.providerId !== deletedProviderId) return null

  return getUsableProviderIdsForCapability("languageDetection", remainingProviders)[0]
}
