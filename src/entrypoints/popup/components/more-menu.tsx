import { Icon } from "@iconify/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/base-ui/dropdown-menu"
import { i18n } from "@/utils/i18n"

export function MoreMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1"
          />
        }
      >
        <Icon icon="tabler:dots" className="size-4" />
        <span>{i18n.t("popup.more.title")}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuItem
          onClick={() =>
            window.open(
              "https://github.com/aittaa/lingo-tori/issues",
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <Icon icon="tabler:bug" className="size-4" />
          {i18n.t("popup.more.bugReport")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
