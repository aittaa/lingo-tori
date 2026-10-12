import type { ViewId } from "."
import { VISIBLE_SUBPAGES } from "."
import { CopySourceSubtitles } from "../components/copy-source-subtitles"
import { CopyTranslatedSubtitles } from "../components/copy-translated-subtitles"
import { SubpageMenuEntry } from "../components/subpage-menu-entry"
import { SubtitlesSidebarItem } from "../components/subtitles-sidebar-item"
import { SubtitlesToggle } from "../components/subtitles-toggle"

export function MainMenu({ onNavigate }: { onNavigate: (id: ViewId) => void }) {
  return (
    <div className="p-1">
      <div className="space-y-0.5">
        <SubtitlesToggle />
        <CopyTranslatedSubtitles />
        <CopySourceSubtitles />
        <SubtitlesSidebarItem />

        {VISIBLE_SUBPAGES.map((page) => (
          <SubpageMenuEntry
            key={page.id}
            icon={page.icon}
            label={page.title()}
            onClick={() => onNavigate(page.id)}
          />
        ))}
      </div>
    </div>
  )
}
