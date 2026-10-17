import { IconAlertCircle } from "@tabler/icons-react"
import { useAtomValue, useSetAtom } from "jotai"
import { Button } from "@/components/ui/base-ui/button"
import { configUnusableReasonAtom, configWriteFailureAtom } from "@/utils/atoms/config-health"
import { i18n } from "@/utils/i18n"
import { Alert, AlertDescription, AlertTitle } from "../ui/base-ui/alert"

const FAILURE_KEYS = {
  refused: "configHealth.failure.refused",
  "unknown-outcome": "configHealth.failure.unknownOutcome",
  unavailable: "configHealth.failure.unavailable",
  conflict: "configHealth.failure.conflict",
  preservation: "configHealth.failure.preservation",
  other: "configHealth.failure.other",
} as const

/**
 * The one place that tells the user a change was not saved, shared by the options page and the
 * popup. Two cases:
 *
 * - the stored config cannot be used by this version: every change is refused until it is dealt
 *   with, so the banner says so and points to the recovery options (`onOpenRecovery`);
 * - the last change a screen made was not saved for another reason (not allowed, outcome not known,
 *   the saving part not reachable, other changes in the way): the banner says that until the next
 *   change is saved or the user dismisses it.
 *
 * It renders nothing when all is well.
 */
export function ConfigHealthBanner({ onOpenRecovery }: { onOpenRecovery: () => void }) {
  const unusable = useAtomValue(configUnusableReasonAtom)
  const failure = useAtomValue(configWriteFailureAtom)
  const setFailure = useSetAtom(configWriteFailureAtom)

  if (unusable) {
    return (
      <Alert variant="destructive" data-testid="config-health-banner">
        <IconAlertCircle />
        <AlertTitle>{i18n.t("configHealth.unusable.title")}</AlertTitle>
        <AlertDescription>
          <p>{i18n.t("configHealth.unusable.description")}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onOpenRecovery}>
            {i18n.t("configHealth.unusable.action")}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (failure) {
    return (
      <Alert variant="warning" data-testid="config-health-banner">
        <IconAlertCircle />
        <AlertTitle>{i18n.t("configHealth.failure.title")}</AlertTitle>
        <AlertDescription>
          <p>{i18n.t(FAILURE_KEYS[failure.kind])}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setFailure(null)}>
            {i18n.t("configHealth.failure.dismiss")}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return null
}
