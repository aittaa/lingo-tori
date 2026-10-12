import type { ReactNode } from "react"
import type { APIProviderTypes } from "@/types/config/provider"
import { IconBrandOpenai } from "@tabler/icons-react"
import { useSetAtom, useStore } from "jotai"
import { useRef } from "react"
import { requestEditorNavigationAtom } from "@/components/form/autosave-navigation"
import ProviderIcon from "@/components/provider-icon"
import { useTheme } from "@/components/providers/theme-provider"
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/base-ui/dialog"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import {
  API_PROVIDER_ITEMS,
  PROVIDER_GROUPS,
  getProviderItemName,
} from "@/utils/constants/providers"
import { i18n } from "@/utils/i18n"
import { selectedProviderIdAtom } from "./atoms"
import { addProvider } from "./utils"

const providerButtonClassName =
  "relative flex h-auto flex-col items-center space-y-1.5 rounded-lg p-2 outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
const providerLabelClassName =
  "line-clamp-2 flex w-full flex-1 items-center justify-center text-xs font-light"

export default function AddProviderDialog({
  onClose,
  onSelectChatGPT,
}: {
  onClose: () => void
  onSelectChatGPT?: () => void
}) {
  const selectedChatGPT = useRef(false)
  const store = useStore()
  const requestNavigation = useSetAtom(requestEditorNavigationAtom)
  const setProvidersConfig = useSetAtom(configFieldsAtomMap.providersConfig)
  const setSelectedProviderId = useSetAtom(selectedProviderIdAtom)

  const handleAddProvider = async (providerType: APIProviderTypes) => {
    await requestNavigation(async () => {
      await addProvider(
        providerType,
        store.get(configFieldsAtomMap.providersConfig),
        setProvidersConfig,
        setSelectedProviderId,
      )
      onClose()
    })
  }

  return (
    <DialogContent
      finalFocus={() => {
        if (!selectedChatGPT.current) return true
        selectedChatGPT.current = false
        return (
          document.getElementById("chatgpt-model") ??
          document.getElementById("chatgpt-account-card") ??
          true
        )
      }}
      className="max-h-[90vh] overflow-y-auto md:max-w-2xl lg:max-w-4xl xl:max-w-5xl"
    >
      <DialogHeader>
        <DialogTitle>{i18n.t("options.apiProviders.dialog.title")}</DialogTitle>
      </DialogHeader>
      {Object.entries(PROVIDER_GROUPS).map(([groupKey, group]) => (
        <ProviderButtonGroup
          key={groupKey}
          groupTitle={i18n.t(
            `options.apiProviders.dialog.groups.${groupKey as keyof typeof PROVIDER_GROUPS}.title`,
          )}
          groupDescription={i18n.t(
            `options.apiProviders.dialog.groups.${groupKey as keyof typeof PROVIDER_GROUPS}.description`,
          )}
          providerTypes={group.types}
          handleAddProvider={handleAddProvider}
          leadingProvider={
            groupKey === "builtInProviders" && onSelectChatGPT ? (
              <button
                type="button"
                className={providerButtonClassName}
                onClick={() => {
                  selectedChatGPT.current = true
                  onClose()
                  // Closing the modal and starting the shared flow remain one user gesture.
                  onSelectChatGPT()
                }}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-white dark:bg-muted">
                  <IconBrandOpenai aria-hidden="true" className="size-5" stroke={1.5} />
                </span>
                <span className={providerLabelClassName}>ChatGPT</span>
              </button>
            ) : null
          }
        />
      ))}
    </DialogContent>
  )
}

function ProviderButtonGroup({
  groupTitle,
  groupDescription,
  providerTypes,
  handleAddProvider,
  leadingProvider,
}: {
  groupTitle: string
  groupDescription: string
  providerTypes: readonly APIProviderTypes[]
  handleAddProvider: (providerType: APIProviderTypes) => void
  leadingProvider?: ReactNode
}) {
  return (
    <div className="my-2.5">
      <h3 className="font-base text-input-foreground text-center text-base sm:text-left">
        {groupTitle}
      </h3>
      <p className="mt-1 mb-2 text-center text-sm text-muted-foreground sm:text-left">
        {groupDescription}
      </p>
      <div className="grid grid-cols-4 gap-1.5 py-2 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-11">
        {leadingProvider}
        {providerTypes.map((providerType) => (
          <ProviderButton
            key={providerType}
            providerType={providerType}
            handleAddProvider={handleAddProvider}
          />
        ))}
      </div>
    </div>
  )
}

function ProviderButton({
  providerType,
  handleAddProvider,
}: {
  providerType: APIProviderTypes
  handleAddProvider: (providerType: APIProviderTypes) => void
}) {
  const { theme } = useTheme()
  return (
    <button
      type="button"
      key={providerType}
      className={providerButtonClassName}
      onClick={() => handleAddProvider(providerType)}
    >
      <ProviderIcon logo={API_PROVIDER_ITEMS[providerType].logo(theme)} size="md" />
      <span className={providerLabelClassName}>{getProviderItemName(providerType)}</span>
    </button>
  )
}
