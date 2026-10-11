import { GradientBackground } from "@/components/gradient-background"
import { i18n } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { ReadingToolsPreview } from "../../components/reading-tools-preview"
import { ClickActionSection } from "./click-action"
import { DisplaySection } from "./display"
import { EnableItem } from "./enable-item"

export function FloatingButtonPage() {
  return (
    <PageLayout
      title={i18n.t("options.floatingButton.title")}
      description={i18n.t("options.floatingButton.pageDescription")}
      innerClassName="flex flex-col gap-10"
    >
      <GradientBackground>
        <ReadingToolsPreview floating />
      </GradientBackground>
      <EnableItem />
      <DisplaySection />
      <ClickActionSection />
    </PageLayout>
  )
}
