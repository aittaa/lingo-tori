import { useAtom } from "jotai"
import { HelpTooltip } from "@/components/help-tooltip"
import { Switch } from "@/components/ui/base-ui/switch"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"

/**
 * The same global switch as Settings > Video subtitles (`videoSubtitles.autoStart`), so moving it
 * here moves it there. It decides whether foreign-language videos translate themselves; the
 * player's own button only ever acts on the video being watched.
 */
export function ForeignVideoAutoTranslate() {
  const [{ autoStart }, setVideoSubtitles] = useAtom(configFieldsAtomMap.videoSubtitles)
  const title = i18n.t("options.videoSubtitles.preference.autoStart.title")

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-[13px] font-medium">
        {title}
        <HelpTooltip>
          {i18n.t("options.videoSubtitles.preference.autoStart.description")}
        </HelpTooltip>
      </span>
      <Switch
        aria-label={title}
        checked={autoStart}
        onCheckedChange={(checked) => {
          void setVideoSubtitles({ autoStart: checked })
        }}
      />
    </div>
  )
}
