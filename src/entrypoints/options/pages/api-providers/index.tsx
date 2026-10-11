import type { ByosSettingsHandle } from "../byos"
import { useCallback, useRef } from "react"
import { i18n } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { ByosSettings } from "../byos"
import { AIContentAwareConfig } from "./ai-content-aware"
import { FeatureProvidersConfig } from "./feature-providers"
import { LanguageDetectionConfig } from "./language-detection"
import { ProvidersConfig } from "./providers-config"

export function ApiProvidersPage() {
  const chatGPT = useRef<ByosSettingsHandle>(null)
  const selectChatGPT = useCallback(() => {
    chatGPT.current?.selectChatGPT()
  }, [])
  return (
    <PageLayout title={i18n.t("options.apiProviders.title")} innerClassName="flex flex-col gap-8">
      <ByosSettings ref={chatGPT} />
      <ProvidersConfig onSelectChatGPT={selectChatGPT} />
      <FeatureProvidersConfig />
      <LanguageDetectionConfig />
      <AIContentAwareConfig />
    </PageLayout>
  )
}
