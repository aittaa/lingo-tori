import type { Config } from "@/types/config/config"
import type { APIProviderConfig, APIProviderTypes } from "@/types/config/provider"
import type { ConfigUpdate } from "@/utils/atoms/config"
import { buildFirstProviderDefaultsPatch } from "@/utils/config/first-provider-defaults"
import {
  DEFAULT_PROVIDER_CONFIG,
  getDefaultProviderDescription,
  getProviderItemName,
} from "@/utils/constants/providers"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { getUniqueName } from "@/utils/name"

export async function addProvider(
  providerType: APIProviderTypes,
  writeConfig: (update: ConfigUpdate) => Promise<void>,
  setSelectedProviderId?: (id: string) => void,
): Promise<string> {
  const description = getDefaultProviderDescription(providerType)
  const newProvider: APIProviderConfig = {
    ...structuredClone(DEFAULT_PROVIDER_CONFIG[providerType]),
    ...(description ? { description } : {}),
    id: getRandomUUID(),
    name: getProviderItemName(providerType),
  }

  await writeConfig((current) => {
    // Config writers may evaluate an updater for both optimistic and persisted state.
    if (current.providersConfig.some((provider) => provider.id === newProvider.id)) return {}
    const provider = {
      ...newProvider,
      name: getUniqueName(newProvider.name, new Set(current.providersConfig.map((p) => p.name))),
    }
    return {
      ...buildFirstProviderDefaultsPatch(current, provider),
      providersConfig: [...current.providersConfig, provider],
    }
  })

  if (setSelectedProviderId) {
    setSelectedProviderId(newProvider.id)
  }

  return newProvider.id
}

export async function duplicateProvider(
  providerConfig: APIProviderConfig,
  providersConfig: Config["providersConfig"],
  setProvidersConfig: (config: Partial<Config["providersConfig"]>) => Promise<void>,
  setSelectedProviderId?: (id: string) => void,
): Promise<string> {
  const existingNames = new Set(providersConfig.map((p) => p.name))
  const newProvider: APIProviderConfig = {
    ...structuredClone(providerConfig),
    id: getRandomUUID(),
    name: getUniqueName(providerConfig.name, existingNames),
  }

  const updatedProviders = [...providersConfig, newProvider]
  await setProvidersConfig(updatedProviders)

  if (setSelectedProviderId) {
    setSelectedProviderId(newProvider.id)
  }

  return newProvider.id
}
