import type { ReactNode } from "react"
import type { LangCodeISO6393 } from "@/lib/languages"
import type { OnboardingAction, OnboardingState } from "@/utils/onboarding/lifecycle"
import { useAtomValue } from "jotai"
import { useEffect, useId, useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { browser } from "#imports"
import { LanguageCombobox } from "@/components/language-combobox"
import { Button } from "@/components/ui/base-ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/base-ui/card"
import { Label } from "@/components/ui/base-ui/label"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { readOnboardingState } from "@/utils/onboarding/lifecycle"
import { pickInitialTargetChoice } from "@/utils/onboarding/suggested-language"

type Failure = "target" | "complete" | "later"

function getBrowserLocale() {
  try {
    return browser.i18n.getUILanguage()
  } catch {
    return null
  }
}

/** The heading takes focus on arrival, so a screen reader starts at the question. */
function OnboardingHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <h1 ref={ref} tabIndex={-1} className="text-base leading-snug font-medium outline-none">
      {children}
    </h1>
  )
}

function OnboardingDone() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <OnboardingHeading>{i18n.t("onboarding.doneTitle")}</OnboardingHeading>
        <CardDescription>{i18n.t("onboarding.doneDescription")}</CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button render={<Link to="/preference" replace />}>
          {i18n.t("onboarding.goSettings")}
        </Button>
      </CardFooter>
    </Card>
  )
}

function failureOf(action: OnboardingAction, reason: string): Failure {
  if (action.event === "dismiss") return "later"
  // A retry that only records completion has nothing else to fail: the language is already saved.
  if (action.retryCompletionOnly) return "complete"
  return reason === "lifecycle-save-failed" ? "complete" : "target"
}

function failureMessage(failure: Failure) {
  if (failure === "target") return i18n.t("onboarding.errorTarget")
  if (failure === "complete") return i18n.t("onboarding.errorComplete")
  return i18n.t("onboarding.errorLater")
}

function OnboardingQuestion() {
  const navigate = useNavigate()
  const { targetCode: currentTargetCode } = useAtomValue(configFieldsAtomMap.language)
  // Read once: the config atom follows what the answer writes, which must not move the pick.
  const [initial] = useState(() =>
    pickInitialTargetChoice({ currentTargetCode, browserLocale: getBrowserLocale() }),
  )
  const [targetCode, setTargetCode] = useState<LangCodeISO6393>(initial.targetCode)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  const comboboxId = useId()
  const labelId = useId()
  const descriptionId = useId()
  const hintId = useId()
  const showHint = initial.fromBrowserLanguage && targetCode === initial.targetCode

  async function submit(action: OnboardingAction) {
    setBusy(true)
    setFailure(null)
    try {
      const result = await sendMessage("onboardingTransition", action)
      // A profile that was never enrolled has no question to answer: leave quietly.
      if (result.ok || result.reason === "not-eligible") {
        void navigate("/", { replace: true })
        return
      }
      setFailure(failureOf(action, result.reason))
    } catch {
      // The background could not be reached: what it did, if anything, is unknown.
      setFailure(failureOf(action, "unreachable"))
    }
    setBusy(false)
  }

  // After `lifecycle-save-failed` the selection on screen is already saved, so confirming it again
  // only has to record completion. Picking another language clears that state, and the next Use is
  // an ordinary confirmation that saves the new choice.
  const completion: OnboardingAction =
    failure === "complete"
      ? { event: "complete", targetCode, retryCompletionOnly: true }
      : { event: "complete", targetCode }

  return (
    <Card className="w-full max-w-md" aria-busy={busy}>
      <CardHeader>
        <OnboardingHeading>{i18n.t("onboarding.title")}</OnboardingHeading>
        <CardDescription id={descriptionId}>{i18n.t("onboarding.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Label id={labelId} htmlFor={comboboxId}>
          {i18n.t("onboarding.languageLabel")}
        </Label>
        <LanguageCombobox
          id={comboboxId}
          aria-labelledby={labelId}
          aria-describedby={showHint ? `${descriptionId} ${hintId}` : descriptionId}
          className="w-full"
          value={targetCode}
          disabled={busy}
          // No `autoLabel`, so the list holds real languages only; the guard keeps the type honest.
          onValueChange={(code) => {
            if (code === "auto") return
            setTargetCode(code)
            setFailure(null)
          }}
        />
        {showHint && (
          <p id={hintId} className="text-sm text-muted-foreground">
            {i18n.t("onboarding.suggested")}
          </p>
        )}
        {failure && (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
            <p>{failureMessage(failure)}</p>
            {failure === "complete" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void submit(completion)}
              >
                {i18n.t("onboarding.retry")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void submit({ event: "dismiss" })}>
          {i18n.t("onboarding.later")}
        </Button>
        <Button disabled={busy} onClick={() => void submit(completion)}>
          {busy ? i18n.t("onboarding.saving") : i18n.t("onboarding.use")}
        </Button>
      </CardFooter>
    </Card>
  )
}

function OnboardingView({ state }: { state: OnboardingState | null }) {
  if (state === null) return null
  // Only an enrolled profile that has not finished is asked. Anyone else — never enrolled, an
  // unreadable record, or done — gets a pointer to settings, and nothing is written.
  return state === "pending" || state === "dismissed" ? <OnboardingQuestion /> : <OnboardingDone />
}

/**
 * The first-run question: which language translations should be in. Internal — opened by the
 * background after a first install, and by the root route while the question is still pending. It
 * has no sidebar entry. Closing or reloading the page saves nothing; settings stays the place to
 * change the language afterwards.
 */
export function OnboardingPage() {
  const [state, setState] = useState<OnboardingState | null>(null)

  useEffect(() => {
    let active = true
    void readOnboardingState().then(
      (value) => {
        if (active) setState(value)
      },
      () => {
        // Unreadable storage is not a reason to ask, and certainly not to write.
        if (active) setState("invalid")
      },
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <OnboardingView state={state} />
    </div>
  )
}
