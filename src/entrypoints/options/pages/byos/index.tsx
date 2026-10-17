import type { Ref } from "react"
import type { ByosSession } from "@/utils/byos/service"
import { IconBrandOpenai, IconDots, IconExternalLink, IconLogout } from "@tabler/icons-react"
import { useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Navigate } from "react-router"
import { browser } from "wxt/browser"
import { DataConsentRow } from "@/components/data-consent/data-consent-row"
import { Button } from "@/components/ui/base-ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/base-ui/dropdown-menu"
import { configAtom, writeConfigAtom } from "@/utils/atoms/config"
import { isByosExtensionUrl } from "@/utils/byos/browser"
import { sendByosMessage } from "@/utils/byos/messages"
import { requestByosCallbackPermission } from "@/utils/byos/permissions"
import { isDataConsentRequiredError, requestDataConsent } from "@/utils/firefox-data-consent"
import { getUiLocale } from "@/utils/i18n"
import { cn } from "@/utils/styles/utils"
import { reconcileModelSelection } from "./model-selection"
import { buildByosProviderPatch } from "./provider-patch"

const copy = {
  en: {
    signIn: "Sign in with ChatGPT",
    reconnect: "Reconnect",
    retry: "Try again",
    cancel: "Cancel",
    checking: "Checking connection…",
    waiting: "Complete sign-in in the opened tab.",
    permission: "Waiting for sign-in permission…",
    starting: "Opening sign-in…",
    disconnected: "Connect your account",
    connected: "Connected",
    identity: "Plan access unavailable",
    restricted: "Account access restricted",
    limit: "Usage limit reached",
    expired: "Sign-in expired",
    unavailable: "Connection unavailable",
    browser: "ChatGPT sign-in is available in Firefox and Chromium browsers.",
    denied: "Sign-in permission was not granted.",
    consentDenied: "Firefox permission to send sign-in data was not granted.",
    consent: "Firefox data consent is needed to send sign-in data. Allow it, then try again.",
    failed: "Could not connect. Try again.",
    ended: "Sign-in did not finish. Try again.",
    background: "Extension connection unavailable. Reload this settings page and try again.",
    callback: "Allow callback access to start sign-in.",
    routing: "If sign-in fails, restart the extension and try again.",
    restart: "Restart extension",
    restartFailed: "Could not restart the extension. Try again.",
    model: "Model",
    choose: "Choose a model",
    save: "Save model",
    saved: "Model saved",
    signOut: "Sign out",
    usage: "Manage ChatGPT usage",
    menu: "ChatGPT account options",
    revoked: "Signed out locally; remote revocation unconfirmed.",
    signedOut: "Signed out",
    assigning: "Choose where to use this model in Feature providers.",
    details: "Connection details",
    detailText: "Credentials stay in this browser.",
    usageText:
      "Requests made through your ChatGPT connection count toward your ChatGPT Work/Codex usage limits. In ChatGPT settings, you can check usage and, where available, set weekly limits per app.",
    usageLink: "Manage usage and limits",
  },
  ko: {
    signIn: "ChatGPT로 로그인",
    reconnect: "다시 연결",
    retry: "다시 시도",
    cancel: "취소",
    checking: "연결 확인 중…",
    waiting: "열린 탭에서 로그인을 완료하세요.",
    permission: "로그인 권한을 기다리는 중…",
    starting: "로그인을 여는 중…",
    disconnected: "계정 연결",
    connected: "연결됨",
    identity: "요금제 사용 권한 없음",
    restricted: "계정 사용 제한",
    limit: "사용량 한도 도달",
    expired: "로그인 만료",
    unavailable: "연결할 수 없음",
    browser: "ChatGPT 로그인은 Firefox와 Chromium 브라우저에서 사용할 수 있습니다.",
    denied: "로그인 권한이 허용되지 않았습니다.",
    consentDenied: "로그인 정보를 보내기 위한 Firefox 권한이 허용되지 않았습니다.",
    consent: "로그인 정보를 보내려면 Firefox 데이터 동의가 필요합니다. 허용한 뒤 다시 시도하세요.",
    failed: "연결하지 못했습니다. 다시 시도하세요.",
    ended: "로그인이 완료되지 않았습니다. 다시 시도하세요.",
    background:
      "확장 프로그램에 연결할 수 없습니다. 이 설정 페이지를 새로고침하고 다시 시도하세요.",
    callback: "로그인을 시작하려면 콜백 접근을 허용하세요.",
    routing: "연결이 안 되면 확장을 다시 시작한 뒤 다시 시도해 주세요.",
    restart: "확장 다시 시작",
    restartFailed: "확장 프로그램을 다시 시작하지 못했습니다. 다시 시도하세요.",
    model: "모델",
    choose: "모델 선택",
    save: "모델 저장",
    saved: "모델 저장됨",
    signOut: "로그아웃",
    usage: "ChatGPT 사용량 관리",
    menu: "ChatGPT 계정 옵션",
    revoked: "로컬에서 로그아웃했습니다. 원격 해제는 확인되지 않았습니다.",
    signedOut: "로그아웃됨",
    assigning: "기능별 제공자에서 이 모델을 사용할 기능을 선택하세요.",
    details: "연결 정보",
    detailText: "인증 정보는 이 브라우저에 저장됩니다.",
    usageText:
      "ChatGPT 연결로 실행한 요청은 ChatGPT Work/Codex 사용량 한도에 포함됩니다. ChatGPT 설정에서 사용량을 확인하고, 지원되는 경우 앱별 주간 사용량 한도를 설정할 수 있습니다.",
    usageLink: "사용량 및 한도 관리",
  },
  ja: {
    signIn: "ChatGPT でログイン",
    reconnect: "再接続",
    retry: "再試行",
    cancel: "キャンセル",
    checking: "接続を確認中…",
    waiting: "開いたタブでログインを完了してください。",
    permission: "ログイン権限を待っています…",
    starting: "ログインを開いています…",
    disconnected: "アカウントを接続",
    connected: "接続済み",
    identity: "プランの利用権限なし",
    restricted: "アカウントの利用制限",
    limit: "使用量の上限に到達",
    expired: "ログイン期限切れ",
    unavailable: "接続できません",
    browser: "ChatGPT ログインは Firefox と Chromium ブラウザーで利用できます。",
    denied: "ログイン権限が許可されませんでした。",
    consentDenied: "ログイン情報を送信するための Firefox の権限が許可されませんでした。",
    consent:
      "ログイン情報を送信するには Firefox のデータ同意が必要です。許可してから再試行してください。",
    failed: "接続できませんでした。再試行してください。",
    ended: "ログインが完了しませんでした。再試行してください。",
    background: "拡張機能に接続できません。この設定ページを再読み込みして再試行してください。",
    callback: "ログインを開始するにはコールバックへのアクセスを許可してください。",
    routing: "接続できない場合は、拡張機能を再起動してから再試行してください。",
    restart: "拡張機能を再起動",
    restartFailed: "拡張機能を再起動できませんでした。再試行してください。",
    model: "モデル",
    choose: "モデルを選択",
    save: "モデルを保存",
    saved: "モデルを保存しました",
    signOut: "ログアウト",
    usage: "ChatGPT 使用量を管理",
    menu: "ChatGPT アカウントのオプション",
    revoked: "ローカルでログアウトしました。リモートの解除は未確認です。",
    signedOut: "ログアウト済み",
    assigning: "機能別プロバイダーで、このモデルを使う機能を選んでください。",
    details: "接続情報",
    detailText: "認証情報はこのブラウザーに保存されます。",
    usageText:
      "ChatGPT 接続を通じたリクエストは ChatGPT Work/Codex の使用量上限に含まれます。ChatGPT の設定で使用量を確認でき、対応している場合はアプリごとの週間上限を設定できます。",
    usageLink: "使用量と上限を管理",
  },
}
async function boundedMessage<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("background_timeout")), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const failureKind = (error: unknown) => {
  if (isDataConsentRequiredError(error)) return "consent" as const
  const message = error instanceof Error ? error.message : ""
  if (/callback_rule_timeout/i.test(message)) return "routing" as const
  if (/receiving end|establish connection|background_timeout/i.test(message))
    return "background" as const
  if (/callback_permission|browser_only_signin_unavailable/i.test(message))
    return "callback" as const
  return "failed" as const
}
const epoch = (generation: { current: number }) => generation.current
const invalidate = (generation: { current: number }) => ++generation.current
export function ByosPage() {
  return <Navigate to="/api-providers" replace />
}
export interface ByosSettingsHandle {
  selectChatGPT: () => void
}
export function ByosSettings({ ref }: { ref?: Ref<ByosSettingsHandle> }) {
  const locale = getUiLocale(),
    t = copy[locale === "ko" ? "ko" : locale === "ja" ? "ja" : "en"]
  const config = useAtomValue(configAtom),
    writeConfig = useSetAtom(writeConfigAtom)
  const savedModel = config.providersConfig.find((provider) => provider.provider === "byos")?.model
    .customModel
  const [session, setSession] = useState<ByosSession>({ state: "disconnected" })
  const [models, setModels] = useState<{ slug: string; display_name: string }[]>([])
  const [model, setModel] = useState("")
  const [notice, setNotice] = useState("")
  const [routingFailed, setRoutingFailed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [busy, setBusy] = useState(true)
  const [pending, setPending] = useState<"permission" | "starting" | "tab" | null>(null)
  const cardRef = useRef<HTMLElement>(null),
    modelRef = useRef<HTMLSelectElement>(null)
  const initialRegistrationAttempt = useRef(false)
  const generation = useRef(0),
    restartRequested = useRef(false),
    authAttemptRef = useRef<string | undefined>(undefined),
    busyRef = useRef(true),
    pendingRef = useRef<"permission" | "starting" | "tab" | null>(null)
  const supportedBrowser =
    isByosExtensionUrl(browser.runtime.getURL("/")) &&
    typeof browser.permissions.request === "function"
  const setWorking = useCallback((working: boolean) => {
    busyRef.current = working
    setBusy(working)
  }, [])
  const setAttempt = useCallback((attempt: "permission" | "starting" | "tab" | null) => {
    pendingRef.current = attempt
    setPending(attempt)
  }, [])
  const refresh = useCallback(
    async (owner: number) => {
      let next: ByosSession
      try {
        next = await boundedMessage(sendByosMessage("lingotoriByosSession", undefined))
      } catch {
        if (epoch(generation) === owner) {
          setSession({ state: "temporarily-unavailable" })
          setNotice(t.failed)
        }
        return
      }
      if (epoch(generation) !== owner) return
      setSession(next)
      authAttemptRef.current = next.authPending ? next.authAttemptId : undefined
      if (next.authPending) {
        setAttempt("tab")
        setModels([])
        setModel("")
        return
      }
      if (next.state === "disconnected") {
        if (next.authPending === false) initialRegistrationAttempt.current = false
        setModels([])
        setModel("")
        if (next.authPending === false && pendingRef.current === "tab") {
          setAttempt(null)
          setNotice(t.ended)
        }
        return
      }
      setAttempt(null)
      if (next.state !== "plan-enabled") {
        initialRegistrationAttempt.current = false
        setModels([])
        setModel("")
        return
      }
      setRoutingFailed(false)
      try {
        const available = await boundedMessage(sendByosMessage("lingotoriByosModels", undefined))
        if (epoch(generation) !== owner) return
        setModels(available.models)
        setModel((previous) => reconcileModelSelection(available.models, previous, savedModel))
        const initialModel = reconcileModelSelection(available.models, "", savedModel)
        if (initialRegistrationAttempt.current && initialModel) {
          // Only an explicit first connection can register defaults here; mount refreshes cannot.
          initialRegistrationAttempt.current = false
          await writeConfig((current) =>
            current.providersConfig.length === 0
              ? buildByosProviderPatch(current, initialModel)
              : {},
          )
        }
      } catch (error) {
        const recovered = await boundedMessage(
          sendByosMessage("lingotoriByosSession", undefined),
        ).catch(() => ({
          state: "temporarily-unavailable" as const,
        }))
        if (epoch(generation) !== owner) return
        setModels([])
        setModel("")
        setSession(
          recovered.state === "plan-enabled"
            ? { ...recovered, state: "temporarily-unavailable" }
            : recovered,
        )
        setNotice(isDataConsentRequiredError(error) ? t.consent : t.failed)
      }
    },
    [savedModel, setAttempt, t, writeConfig],
  )
  useEffect(() => {
    const owner = invalidate(generation)
    void Promise.resolve()
      .then(async () => {
        if (restartRequested.current || epoch(generation) !== owner) return
        setWorking(true)
        await refresh(owner)
      })
      .finally(() => {
        if (epoch(generation) === owner) setWorking(false)
      })
    const onReturn = () => {
      if (
        document.visibilityState === "hidden" ||
        busyRef.current ||
        pendingRef.current === "permission"
      )
        return
      const current = invalidate(generation)
      setWorking(true)
      void refresh(current).finally(() => {
        if (epoch(generation) === current) setWorking(false)
      })
    }
    window.addEventListener("focus", onReturn)
    document.addEventListener("visibilitychange", onReturn)
    return () => {
      invalidate(generation)
      window.removeEventListener("focus", onReturn)
      document.removeEventListener("visibilitychange", onReturn)
    }
  }, [refresh, setWorking])
  function signIn() {
    initialRegistrationAttempt.current = config.providersConfig.length === 0
    const owner = invalidate(generation)
    const attemptId = crypto.randomUUID()
    authAttemptRef.current = attemptId
    setAttempt("permission")
    setWorking(true)
    setNotice("")
    setModels([])
    setModel("")
    let permission: Promise<boolean>
    let consent: Promise<boolean>
    // Request directly in the explicit button gesture, before awaiting anything. Firefox's data
    // consent for sending sign-in data is asked in the same turn (a Chrome build resolves at once).
    try {
      permission = requestByosCallbackPermission()
      consent = requestDataConsent("authenticationInfo")
    } catch (error) {
      setAttempt(null)
      setWorking(false)
      initialRegistrationAttempt.current = false
      setNotice(t[failureKind(error)])
      return
    }
    void (async () => {
      try {
        const granted = await permission
        if (epoch(generation) !== owner) return
        if (!granted) {
          initialRegistrationAttempt.current = false
          setAttempt(null)
          setNotice(t.denied)
          return
        }
        const consented = await consent
        if (epoch(generation) !== owner) return
        if (!consented) {
          initialRegistrationAttempt.current = false
          setAttempt(null)
          setNotice(t.consentDenied)
          return
        }
        setAttempt("starting")
        await boundedMessage(sendByosMessage("lingotoriByosAuth", attemptId))
        if (epoch(generation) === owner) {
          setRoutingFailed(false)
          setAttempt("tab")
        }
      } catch (error) {
        if (epoch(generation) === owner) {
          invalidate(generation)
          initialRegistrationAttempt.current = false
          setAttempt(null)
          setWorking(false)
          const failure = failureKind(error)
          if (failure === "routing") setRoutingFailed(true)
          setNotice(t[failure])
          void boundedMessage(sendByosMessage("lingotoriByosCancelAuth", attemptId)).catch(() => {})
        }
      } finally {
        if (epoch(generation) === owner) setWorking(false)
      }
    })()
  }
  function restartExtension() {
    if (!routingFailed || restartRequested.current) return
    restartRequested.current = true
    invalidate(generation)
    setRestarting(true)
    setWorking(true)
    setAttempt(null)
    try {
      browser.runtime.reload()
    } catch {
      restartRequested.current = false
      setRestarting(false)
      setWorking(false)
      setNotice(t.restartFailed)
    }
  }
  function cancel() {
    initialRegistrationAttempt.current = false
    const attemptId = authAttemptRef.current
    if (!attemptId) {
      setNotice(t.background)
      return
    }
    const owner = invalidate(generation)
    setAttempt(null)
    setWorking(true)
    setNotice("")
    void boundedMessage(sendByosMessage("lingotoriByosCancelAuth", attemptId))
      .catch(() => {
        if (epoch(generation) === owner) setNotice(t.failed)
      })
      .finally(async () => {
        if (epoch(generation) === owner)
          await refresh(owner).catch(() => {
            if (epoch(generation) === owner) setNotice(t.failed)
          })
        if (epoch(generation) === owner) setWorking(false)
      })
  }
  function signOut() {
    initialRegistrationAttempt.current = false
    const owner = invalidate(generation)
    setAttempt(null)
    setWorking(true)
    setSession({ state: "disconnected" })
    setModels([])
    setModel("")
    setNotice("")
    void boundedMessage(sendByosMessage("lingotoriByosSignout", undefined))
      .then(
        (result) => {
          if (epoch(generation) === owner)
            setNotice(result.remoteRevocationConfirmed ? t.signedOut : t.revoked)
        },
        () => {
          if (epoch(generation) === owner) setNotice(t.failed)
        },
      )
      .finally(() => {
        if (epoch(generation) === owner) setWorking(false)
      })
  }
  function retry() {
    const owner = invalidate(generation)
    setWorking(true)
    setNotice("")
    void refresh(owner).finally(() => {
      if (epoch(generation) === owner) setWorking(false)
    })
  }
  function save() {
    const owner = invalidate(generation)
    setWorking(true)
    setNotice("")
    void writeConfig((current) => buildByosProviderPatch(current, model))
      .then(
        () => {
          if (epoch(generation) === owner) setNotice(t.saved)
        },
        () => {
          if (epoch(generation) === owner) setNotice(t.failed)
        },
      )
      .finally(() => {
        if (epoch(generation) === owner) setWorking(false)
      })
  }
  function selectChatGPT() {
    const focusCard = () => {
      cardRef.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" })
      if (session.account && modelRef.current) modelRef.current.focus()
      else cardRef.current?.focus()
    }
    if (!supportedBrowser) {
      setNotice(t.browser)
      focusCard()
      return
    }
    if (pendingRef.current || busyRef.current) {
      focusCard()
      return
    }
    if (session.account && session.state === "plan-enabled") {
      focusCard()
      return
    }
    if (session.state === "temporarily-unavailable") {
      retry()
      return
    }
    signIn()
  }
  useImperativeHandle(ref, () => ({ selectChatGPT }))
  const account = session.account
  const connected = !!account
  const status =
    busy && !pending && session.state === "disconnected"
      ? t.checking
      : pending === "permission"
        ? t.permission
        : pending === "starting"
          ? t.starting
          : pending === "tab"
            ? t.waiting
            : session.state === "plan-enabled"
              ? t.connected
              : session.state === "identity-only"
                ? t.identity
                : session.state === "restricted"
                  ? t.restricted
                  : session.state === "limit-reached"
                    ? t.limit
                    : session.state === "reconnect-required"
                      ? t.expired
                      : session.state === "temporarily-unavailable"
                        ? t.unavailable
                        : t.disconnected
  const recovery = ["identity-only", "restricted", "limit-reached", "reconnect-required"].includes(
    session.state,
  )
  const canSave =
    session.state === "plan-enabled" && models.some((available) => available.slug === model)
  return (
    <section
      ref={cardRef}
      id="chatgpt-account-card"
      tabIndex={-1}
      aria-labelledby="chatgpt-account-title"
      className="rounded-xl border border-border bg-card p-5 text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
            <IconBrandOpenai className="size-6" aria-hidden="true" stroke={1.5} />
          </div>
          <div className="min-w-0 space-y-1">
            <h2 id="chatgpt-account-title" className="text-xl leading-6 font-medium tracking-tight">
              ChatGPT
            </h2>
            {account?.email && (
              <p className="truncate text-sm text-foreground" title={account.email}>
                {account.email}
              </p>
            )}
            <p role="status" className="text-[13px] leading-5 text-muted-foreground">
              {status}
            </p>
          </div>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            (!connected || pending) && "max-sm:w-full max-sm:justify-end",
          )}
        >
          {pending ? (
            <Button
              variant="outline"
              className="h-10 px-4 transition-colors motion-reduce:transition-none"
              onClick={cancel}
            >
              {t.cancel}
            </Button>
          ) : (
            <>
              {routingFailed ? (
                <Button
                  variant="accent"
                  className="h-10 px-4 transition-colors motion-reduce:transition-none"
                  disabled={restarting}
                  onClick={restartExtension}
                >
                  {t.restart}
                </Button>
              ) : (
                (!connected || recovery || session.state === "temporarily-unavailable") && (
                  <Button
                    variant="accent"
                    className="h-10 px-4 transition-colors motion-reduce:transition-none"
                    disabled={
                      busy || (!supportedBrowser && session.state !== "temporarily-unavailable")
                    }
                    onClick={selectChatGPT}
                  >
                    {session.state === "temporarily-unavailable"
                      ? t.retry
                      : recovery
                        ? t.reconnect
                        : t.signIn}
                  </Button>
                )
              )}
              {connected && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger
                    aria-label={t.menu}
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-10 transition-colors motion-reduce:transition-none"
                      />
                    }
                  >
                    <IconDots aria-hidden="true" className="size-5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52 motion-reduce:animate-none">
                    <DropdownMenuItem
                      render={
                        <a
                          href="https://chatgpt.com/#settings/Usage"
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      <IconExternalLink aria-hidden="true" />
                      {t.usage}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={signOut}>
                      <IconLogout aria-hidden="true" />
                      {t.signOut}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
        </div>
      </div>
      {connected && !pending && session.state === "plan-enabled" && (
        <div className="mt-5 border-t border-border pt-5">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium">
              {t.model}
              <select
                ref={modelRef}
                id="chatgpt-model"
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                disabled={busy || !models.length}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">{t.choose}</option>
                {models.map((available) => (
                  <option key={available.slug} value={available.slug}>
                    {available.display_name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              className="h-10 px-4 transition-colors motion-reduce:transition-none"
              disabled={busy || !canSave}
              onClick={save}
            >
              {t.save}
            </Button>
          </div>
          <p className="mt-2.5 text-[13px] leading-5 text-muted-foreground">{t.assigning}</p>
        </div>
      )}
      {!supportedBrowser && !connected && (
        <p className="mt-3 text-[13px] text-muted-foreground">{t.browser}</p>
      )}
      {/* Signing in asks in the click itself; the row is for an account that is already connected. */}
      {(connected || recovery) && <DataConsentRow category="authenticationInfo" className="mt-4" />}
      {notice && (
        <p role="status" className="mt-3 text-[13px] leading-5 text-muted-foreground">
          {notice}
        </p>
      )}
      {connected && !pending && (
        <div
          role="group"
          aria-labelledby="chatgpt-connection-details-title"
          className="mt-4 border-t border-border pt-4 text-[13px] text-muted-foreground"
        >
          <h3 id="chatgpt-connection-details-title" className="font-medium text-foreground">
            {t.details}
          </h3>
          <p className="mt-2 max-w-prose leading-5">{t.detailText}</p>
          <p className="mt-2 max-w-prose leading-5">{t.usageText}</p>
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex w-fit items-center gap-1 rounded-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t.usageLink}
            <IconExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        </div>
      )}
    </section>
  )
}
