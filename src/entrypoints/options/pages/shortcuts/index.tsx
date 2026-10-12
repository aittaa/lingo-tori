import { i18n } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { ActionShortcuts } from "./action-shortcuts"
import { NodeTranslationHotkey } from "./node-translation-hotkey"
import { PageTranslationShortcut } from "./page-translation-shortcut"
import { SelectionTranslationShortcut } from "./selection-translation-shortcut"
import { SubtitlesToggleShortcut } from "./subtitles-toggle-shortcut"
import { TranslationModeShortcut } from "./translation-mode-shortcut"

/**
 * The reading shortcuts in one flat list: few enough that headings between them would only
 * get in the way. They come first, narrowing scope as the list goes down.
 * The AI actions follow under a heading of their own: there is one row per action, as many
 * as the user has made.
 */
export function ShortcutsPage() {
  return (
    <PageLayout
      title={i18n.t("options.shortcuts.title")}
      description={i18n.t("options.shortcuts.pageDescription")}
      innerClassName="flex flex-col gap-6"
    >
      <PageTranslationShortcut />
      <TranslationModeShortcut />
      <SelectionTranslationShortcut />
      <SubtitlesToggleShortcut />
      <NodeTranslationHotkey />
      <ActionShortcuts />
    </PageLayout>
  )
}
