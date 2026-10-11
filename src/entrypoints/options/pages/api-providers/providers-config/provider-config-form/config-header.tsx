import type { APIProviderTypes } from "@/types/config/provider"
import ProviderIcon from "@/components/provider-icon"
import { useTheme } from "@/components/providers/theme-provider"
import { PROVIDER_ITEMS, getProviderItemName } from "@/utils/constants/providers"

export function ConfigHeader({
  providerType,
}: {
  providerType: APIProviderTypes
  apiKey?: string
}) {
  const { theme } = useTheme()
  const provider = PROVIDER_ITEMS[providerType]
  return (
    <a
      href={provider.website}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2"
    >
      <ProviderIcon
        logo={provider.logo(theme)}
        name={getProviderItemName(providerType)}
        size="base"
      />
    </a>
  )
}
