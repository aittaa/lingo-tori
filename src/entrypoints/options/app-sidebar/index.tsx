import { IconSearch } from "@tabler/icons-react"
import { useSetAtom } from "jotai"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/base-ui/input-group"
import { Kbd } from "@/components/ui/base-ui/kbd"
import { Sidebar, SidebarContent, SidebarHeader } from "@/components/ui/base-ui/sidebar"
import { i18n } from "@/utils/i18n"
import { getCommandPaletteShortcutHint } from "@/utils/os"
import { commandPaletteOpenAtom } from "../command-palette/atoms"
import { CollapseToggle } from "./collapse-toggle"
import { FeaturesNav } from "./features-nav"
import { SettingsNav } from "./settings-nav"

export function AppSidebar() {
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom)
  const commandPaletteShortcutHint = getCommandPaletteShortcutHint()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="transition-all group-data-[state=expanded]:px-5 group-data-[state=expanded]:pt-4">
        <span className="px-2 font-semibold group-data-[collapsible=icon]:hidden">LingoTori</span>
        <InputGroup onClick={() => setCommandPaletteOpen(true)} className="bg-background">
          <InputGroupInput
            readOnly
            placeholder={i18n.t("options.commandPalette.placeholder")}
            className="cursor-pointer"
          />
          <InputGroupAddon>
            <IconSearch className="size-4 text-muted-foreground group-data-[state=collapsed]:-mx-px" />
          </InputGroupAddon>
          <InputGroupAddon align="inline-end" className="group-data-[state=collapsed]:hidden">
            <Kbd>{commandPaletteShortcutHint}</Kbd>
          </InputGroupAddon>
        </InputGroup>
      </SidebarHeader>
      <SidebarContent className="transition-all group-data-[state=expanded]:px-2">
        <SettingsNav />
        <FeaturesNav />
      </SidebarContent>
      <CollapseToggle />
    </Sidebar>
  )
}
