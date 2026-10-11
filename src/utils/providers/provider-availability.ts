import type { ProviderCapability } from "./provider-registry"
import type { ProvidersConfig } from "@/types/config/provider"
import { getProviderIdsForCapability } from "./provider-registry"
export function getUsableProviderIdsForCapability(
  capability: ProviderCapability,
  providersConfig: ProvidersConfig,
): string[] {
  return getProviderIdsForCapability(capability, providersConfig, { requireEnable: true })
}
