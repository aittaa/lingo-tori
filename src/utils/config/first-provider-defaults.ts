import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import {
  buildFeatureProviderPatch,
  FEATURE_KEYS,
  FEATURE_PROVIDER_DEFS,
} from "@/utils/constants/feature-providers"
import { isLocalProviderConfigCompatibleWithCapability } from "@/utils/providers/provider-registry"

function isEmptyProviderId(providerId: string) {
  return providerId === "" || providerId === "unconfigured"
}

/** Assign empty supported slots only while registering into an empty provider list. */
export function buildFirstProviderDefaultsPatch(
  current: Config,
  newProvider: ProviderConfig,
): Partial<Config> {
  if (current.providersConfig.length !== 0 || !newProvider.enabled) return {}

  const assignments = Object.fromEntries(
    FEATURE_KEYS.filter(
      (featureKey) =>
        isEmptyProviderId(FEATURE_PROVIDER_DEFS[featureKey].getProviderId(current)) &&
        isLocalProviderConfigCompatibleWithCapability(featureKey, newProvider),
    ).map((featureKey) => [featureKey, newProvider.id]),
  )
  const patch = buildFeatureProviderPatch(assignments)

  if (isLocalProviderConfigCompatibleWithCapability("customAction", newProvider)) {
    const builtInActions = { ...current.selectionToolbar.builtInActions }
    let changed = false
    for (const key of ["dictionary", "sentenceAnalysis"] as const) {
      const action = builtInActions[key]
      if (!isEmptyProviderId(action.providerId)) continue
      builtInActions[key] = { ...action, providerId: newProvider.id }
      changed = true
    }
    if (changed) {
      patch.selectionToolbar = {
        ...current.selectionToolbar,
        ...patch.selectionToolbar,
        builtInActions,
      }
    }
  }

  return patch
}
