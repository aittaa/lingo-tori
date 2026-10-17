// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { SidebarProvider } from "@/components/ui/base-ui/sidebar"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { PRIVACY_NOTICE_URL, THIRD_PARTY_NOTICES_PATH } from "@/utils/constants/notices"
import { AboutLinks } from "../about-links"

// jsdom has no matchMedia, which the sidebar's mobile check needs.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})

function renderLinks() {
  return render(
    <SidebarProvider>
      <TooltipProvider>
        <AboutLinks />
      </TooltipProvider>
    </SidebarProvider>,
  )
}

describe("the about links in the settings sidebar", () => {
  it("open the privacy notice in a new tab without handing the page to it", () => {
    renderLinks()

    const link = screen.getByRole("link", { name: "about.privacyNotice" })

    expect(link).toHaveAttribute("href", PRIVACY_NOTICE_URL)
    expect(link).toHaveAttribute("target", "_blank")
    expect(link.getAttribute("rel")).toMatch(/noopener/)
  })

  it("open the third-party notices from inside the extension, not from the network", () => {
    renderLinks()

    const link = screen.getByRole("link", { name: "about.thirdPartyNotices" })
    const href = link.getAttribute("href") ?? ""

    expect(href).toBe(fakeBrowser.runtime.getURL(THIRD_PARTY_NOTICES_PATH))
    expect(href.endsWith(THIRD_PARTY_NOTICES_PATH)).toBe(true)
    expect(href).not.toMatch(/^https?:/)
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("is a labelled region of the sidebar", () => {
    renderLinks()

    expect(document.querySelector('[data-sidebar="footer"]')).toHaveAttribute(
      "aria-label",
      "about.title",
    )
  })
})
