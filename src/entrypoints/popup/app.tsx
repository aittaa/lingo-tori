import { Icon } from "@iconify/react"
import lingotoriLogo from "@/assets/icons/lingotori.png?url&no-inline"
import { i18n } from "@/utils/i18n"
import { openOptionsPage } from "@/utils/navigation"
import { version } from "../../../package.json"
import { AISmartContext } from "./components/ai-smart-context"
import { AlwaysTranslate } from "./components/always-translate"
import { ForeignVideoAutoTranslate } from "./components/foreign-video-auto-translate"
import LanguageOptionsSelector from "./components/language-options-selector"
import { MoreMenu } from "./components/more-menu"
import Hotkey from "./components/node-translation-hotkey-selector"
import ProvidersField from "./components/providers-field"
import { SiteControlToggle } from "./components/site-control-toggle"
import TranslateButton from "./components/translate-button"
import TranslatePromptSelector from "./components/translate-prompt-selector"
import TranslationModeSelector from "./components/translation-mode-selector"

function App() {
  return (
    <>
      <div className="relative">
        <div className="flex flex-col gap-4 bg-background px-6 pt-5 pb-4">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 font-semibold">
              <img src={lingotoriLogo} alt="" className="size-7" />
              LingoTori
            </span>
          </div>
          <LanguageOptionsSelector />
          <ProvidersField />
          <TranslatePromptSelector />
          <div className="flex w-full items-center gap-2">
            <TranslationModeSelector />
            <TranslateButton className="min-w-0 flex-1" />
          </div>
          <SiteControlToggle />
          <AlwaysTranslate />
          <Hotkey />
          <AISmartContext />
          <ForeignVideoAutoTranslate />
        </div>
        {/* Out of flow on purpose: the card appears on its own schedule, and letting it
            grow the popup would shift every control out from under the user's cursor. */}
      </div>
      <div className="flex items-center justify-between bg-muted px-2 py-1">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 hover:bg-background"
          onClick={() => {
            void openOptionsPage()
          }}
        >
          <Icon icon="tabler:settings" className="size-4" strokeWidth={1.6} />
          <span className="text-[13px] font-medium">{i18n.t("popup.options")}</span>
        </button>
        <span className="text-sm text-muted-foreground">{version}</span>
        <MoreMenu />
      </div>
    </>
  )
}

export default App
