// @vitest-environment jsdom
// The options page's frame shows the banner on every page, and its button leads to the recovery
// notice. The sidebar and the narrow-width bar are stood in for (they need the whole app); the
// banner, the health atoms, the router and the stored config are real.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  corruptConfig,
  CURRENT_META,
  resetStorage,
  seedPrimary,
  settle,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { buildRecoveryNoticeRoute } from "@/utils/navigation"
import { AppShell } from "../app-shell"

vi.mock("../app-sidebar", () => ({ AppSidebar: () => null }))
vi.mock("../narrow-top-bar", () => ({ NarrowTopBar: () => null }))
vi.mock("@/components/ui/base-ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

function Where() {
  const location = useLocation()
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>
}

function renderShell() {
  render(
    <Provider store={createStore()}>
      <MemoryRouter initialEntries={["/api-providers"]}>
        <AppShell>
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </AppShell>
      </MemoryRouter>
    </Provider>,
  )
}

beforeEach(() => {
  resetStorage()
})

afterEach(() => {
  cleanup()
})

describe("the options frame", () => {
  it("shows the banner above whatever page is open when the stored config cannot be used, and leads to the notice", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    renderShell()
    await waitFor(() => screen.getByText("configHealth.unusable.title"))
    expect(screen.getByTestId("where")).toHaveTextContent("/api-providers")
    fireEvent.click(screen.getByText("configHealth.unusable.action"))

    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(buildRecoveryNoticeRoute()),
    )
  })

  it("shows nothing around the page when the stored config can be used", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    renderShell()
    await settle()

    expect(screen.queryByTestId("config-health-banner")).not.toBeInTheDocument()
  })

  it("points to a route the settings page scrolls to (the notice has that id)", () => {
    expect(buildRecoveryNoticeRoute()).toBe("/preference?section=recovery-notice")
  })
})
