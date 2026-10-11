import { Icon } from "@iconify/react"
import { i18n } from "@/utils/i18n"

export function ReadingToolsPreview({ floating = false }: { floating?: boolean }) {
  const tools = [
    { icon: "tabler:language", label: i18n.t("action.translation") },
    {
      icon: "tabler:book",
      label: i18n.t("options.selectionToolbar.customActions.templates.dictionary.name"),
    },
    { icon: "tabler:cards", label: i18n.t("lingotori.study") },
  ]
  return (
    <div aria-hidden="true" className="flex max-w-full items-center gap-3 px-4">
      <div
        className={`flex items-center gap-2 border bg-background shadow-sm ${floating ? "rounded-full p-3" : "rounded-xl px-3 py-2"}`}
      >
        <svg viewBox="0 0 32 32" className="size-8 shrink-0 text-primary" fill="currentColor">
          <path d="M5 22c-1-8 4-13 10-13 3-5 9-4 10 1l5 3-5 2c0 7-5 12-12 12-4 0-7-2-10-5l6 1-4-1Z" />
          <path d="M12 15c0 4 3 7 7 7-5 1-8-2-7-7Z" fill="var(--rf-background)" />
          <circle cx="22" cy="10" r="1" fill="var(--rf-background)" />
        </svg>
        {floating && <span className="text-sm font-medium">LingoTori</span>}
        {!floating &&
          tools.map((tool) => (
            <span
              key={tool.icon}
              className="flex items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5 text-xs"
            >
              <Icon icon={tool.icon} className="size-4" />
              {tool.label}
            </span>
          ))}
      </div>
      {floating && (
        <div className="flex gap-1.5 rounded-xl border bg-background p-2 shadow-sm">
          {tools.map((tool) => (
            <span key={tool.icon} className="rounded-lg bg-muted p-2" title={tool.label}>
              <Icon icon={tool.icon} className="size-5" />
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
