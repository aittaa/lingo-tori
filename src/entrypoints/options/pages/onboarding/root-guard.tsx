import type { ReactNode } from "react"
import { useEffect } from "react"
import { useNavigate } from "react-router"
import { ONBOARDING_ROUTE, readOnboardingState } from "@/utils/onboarding/lifecycle"

/**
 * Sends a profile whose first-run question is still pending back to it when the options page opens
 * at the root. Deep links are other routes and never pass through here, and a dismissed or
 * finished question is not asked again: dismissing means the person chose to leave it.
 */
export function OnboardingRootGuard({ children }: { children: ReactNode }) {
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    void readOnboardingState().then(
      (state) => {
        if (active && state === "pending") void navigate(ONBOARDING_ROUTE, { replace: true })
      },
      () => {
        // Unreadable storage leaves the settings page as it was.
      },
    )
    return () => {
      active = false
    }
  }, [navigate])

  return children
}
