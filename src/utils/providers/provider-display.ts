import type { ProviderConfig } from "@/types/config/provider"
import type { Theme } from "@/types/config/theme"
import { PROVIDER_ITEMS } from "@/utils/constants/providers"
export type ProviderSelectorOption = ProviderConfig
export function getProviderLogo(provider: ProviderSelectorOption, theme: Theme): string {
  return PROVIDER_ITEMS[provider.provider].logo(theme)
}
export function getProviderName(provider: ProviderSelectorOption): string {
  return provider.name
}
export function isProviderSelectorOptionDisabled(provider: ProviderSelectorOption): boolean {
  return !provider.enabled
}
