import type { ReactNode } from "react"
import { useNavigate } from "react-router"
import { ConfigHealthBanner } from "@/components/recovery/config-health-banner"
import { SidebarInset } from "@/components/ui/base-ui/sidebar"
import { buildRecoveryNoticeRoute } from "@/utils/navigation"
import { AppSidebar } from "./app-sidebar"
import { NarrowTopBar } from "./narrow-top-bar"

/**
 * The chrome around every options route: the sidebar, the narrow-width bar that reaches back into
 * it, and the main column the pages render into. Every route shares it, so it wraps `<Routes>`
 * rather than being a layout route — but it stays out of `main.tsx`, which only wires providers.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <NarrowTopBar />
        {/* On every options page: a change that was not saved is never dropped silently. */}
        <div className="px-4 pt-4 empty:hidden md:px-6">
          <ConfigHealthBanner onOpenRecovery={() => void navigate(buildRecoveryNoticeRoute())} />
        </div>
        {children}
      </SidebarInset>
    </>
  )
}
