import { i18n } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { ByosSettings } from "../byos"
import { AIContentAwareConfig } from "./ai-content-aware"
import { FeatureProvidersConfig } from "./feature-providers"
import { LanguageDetectionConfig } from "./language-detection"
import { ProvidersConfig } from "./providers-config"

export function ApiProvidersPage() {
  return (
    <PageLayout title={i18n.t("options.apiProviders.title")} innerClassName="flex flex-col gap-8">
      <ByosSettings />
      <ProvidersConfig />
      <FeatureProvidersConfig />
      <LanguageDetectionConfig />
      <AIContentAwareConfig />
    </PageLayout>
  )
}
