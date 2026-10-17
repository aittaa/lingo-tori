import { IconFileText, IconShieldLock } from "@tabler/icons-react"
import { browser } from "#imports"
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/base-ui/sidebar"
import { PRIVACY_NOTICE_URL, THIRD_PARTY_NOTICES_PATH } from "@/utils/constants/notices"
import { i18n } from "@/utils/i18n"

/**
 * The two notices a user can read from the settings: what the extension sends where, and the
 * licenses of the software inside it. Both open in a new tab. The third-party notices are a file
 * inside the extension and make no request. The privacy notice is a page on GitHub, so opening it
 * makes an ordinary request to github.com; nothing from the settings, a provider or a key goes
 * with it.
 */
export function AboutLinks() {
  const privacy = i18n.t("about.privacyNotice")
  const thirdParty = i18n.t("about.thirdPartyNotices")

  return (
    <SidebarFooter aria-label={i18n.t("about.title")} className="px-2 pb-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={<a href={PRIVACY_NOTICE_URL} target="_blank" rel="noopener noreferrer" />}
            tooltip={privacy}
          >
            <IconShieldLock aria-hidden="true" />
            <span>{privacy}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            render={
              <a
                href={browser.runtime.getURL(THIRD_PARTY_NOTICES_PATH)}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
            tooltip={thirdParty}
          >
            <IconFileText aria-hidden="true" />
            <span>{thirdParty}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  )
}
