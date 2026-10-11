import type { ByosSession } from "@/utils/byos/service"
import { useAtomValue, useSetAtom } from "jotai"
import { useEffect, useRef, useState } from "react"
import { Navigate } from "react-router"
import { browser } from "wxt/browser"
import { configAtom, writeConfigAtom } from "@/utils/atoms/config"
import { sendByosMessage } from "@/utils/byos/messages"
import { getUiLocale } from "@/utils/i18n"
import { ConfigSection } from "../../components/config-section"
import { reconcileModelSelection } from "./model-selection"
import { buildByosProviderPatch } from "./provider-patch"

const copy = {
  en: {
    title: "Sign in with ChatGPT · Experimental BYOS",
    intro:
      "Experimental browser-only sign-in and token storage. This differs from OpenAI’s documented local-runtime flow. Live sign-in, callback routing and inference have not been verified.",
    signIn: "Continue with ChatGPT",
    unavailable:
      "This sign-in requires a Chromium browser and optional callback-routing permission. Permission is requested only when you continue.",
    refresh: "Refresh connection and models",
    signOut: "Sign out of ChatGPT",
    cancel: "Cancel sign-in",
    model: "Available model",
    choose: "Choose a model",
    save: "Save BYOS provider",
    page: "Use for page translation",
    selection: "Use for selection translation",
    dictionary: "Use for dictionary and sentence analysis",
    error:
      "The operation could not be completed. Check callback permission, account access and plan limits, then try again.",
    pending: "Sign-in started. Complete it in the opened tab, then refresh this connection.",
    disconnected: "Signed out",
    connected: "ChatGPT plan access enabled",
    identity: "Signed in; plan access unavailable",
    revoked:
      "Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.",
    byok: "You can configure an API provider with your own API key above.",
    usage: "Manage ChatGPT usage",
    usageHint:
      "Requests use the ChatGPT plan access you authorize, subject to account permissions and usage limits.",
    revokedConfirmed: "Signed out of ChatGPT.",
    saved: "Saved",
    blocked: "Reconnect or check account access and plan limits.",
  },
  ko: {
    title: "ChatGPT로 로그인 · 실험적 BYOS",
    intro:
      "브라우저 전용 로그인과 토큰 저장을 사용하는 실험적 기능입니다. OpenAI의 문서화된 로컬 런타임 방식과 다릅니다. 실제 로그인, 콜백 라우팅 및 추론은 검증되지 않았습니다.",
    signIn: "ChatGPT로 계속",
    unavailable:
      "Chromium 브라우저와 선택적 콜백 라우팅 권한이 필요합니다. 계속 버튼을 누를 때만 권한을 요청합니다.",
    refresh: "연결 및 모델 새로고침",
    signOut: "ChatGPT 로그아웃",
    cancel: "로그인 취소",
    model: "사용 가능한 모델",
    choose: "모델 선택",
    save: "BYOS 제공자 저장",
    page: "페이지 번역에 사용",
    selection: "선택 영역 번역에 사용",
    dictionary: "사전 및 문장 분석에 사용",
    error:
      "작업을 완료하지 못했습니다. 콜백 권한, 계정 사용 권한 및 요금제 한도를 확인하고 다시 시도하세요.",
    pending: "로그인이 시작되었습니다. 열린 탭에서 완료한 다음 연결을 새로고침하세요.",
    disconnected: "로그아웃됨",
    connected: "ChatGPT 요금제 사용 권한 있음",
    identity: "로그인됨; 요금제 사용 권한 없음",
    revoked:
      "로컬에서 로그아웃했습니다. 원격 해제를 확인하지 못했으므로 ChatGPT 설정에서 앱 연결을 해제하세요.",
    byok: "위에서 개인 API 키로 API 제공자를 설정할 수 있습니다.",
    usage: "ChatGPT 사용량 관리",
    usageHint:
      "요청은 승인한 ChatGPT 요금제 사용 권한을 사용하며 계정 권한과 사용량 한도가 적용됩니다.",
    revokedConfirmed: "ChatGPT에서 로그아웃했습니다.",
    saved: "저장됨",
    blocked: "다시 연결하거나 계정 사용 권한 및 요금제 한도를 확인하세요.",
  },
  ja: {
    title: "ChatGPT でログイン · 実験的な BYOS",
    intro:
      "ブラウザーのみのログインとトークン保存を使う実験的な機能です。OpenAI が文書化したローカルランタイム方式とは異なります。実際のログイン、コールバックのルーティング、推論は未検証です。",
    signIn: "ChatGPT で続行",
    unavailable:
      "Chromium ブラウザーと任意のコールバックルーティング権限が必要です。続行ボタンを押したときだけ権限を要求します。",
    refresh: "接続とモデルを更新",
    signOut: "ChatGPT からログアウト",
    cancel: "ログインをキャンセル",
    model: "利用可能なモデル",
    choose: "モデルを選択",
    save: "BYOS プロバイダーを保存",
    page: "ページ翻訳に使用",
    selection: "選択範囲の翻訳に使用",
    dictionary: "辞書と文の分析に使用",
    error:
      "操作を完了できません。コールバック権限、アカウントの権限、プランの上限を確認して再試行してください。",
    pending: "ログインを開始しました。開いたタブで完了してから接続を更新してください。",
    disconnected: "ログアウト済み",
    connected: "ChatGPT プランの利用権限あり",
    identity: "ログイン済み; プラン利用権限なし",
    revoked:
      "ローカルではログアウトしました。リモートでの解除は未確認です。ChatGPT 設定からアプリを解除してください。",
    byok: "上で自分の API キーを使って API プロバイダーを設定できます。",
    usage: "ChatGPT 使用量を管理",
    usageHint:
      "リクエストは承認した ChatGPT プランの利用権限を使い、アカウント権限と使用量の上限が適用されます。",
    revokedConfirmed: "ChatGPT からログアウトしました。",
    saved: "保存しました",
    blocked: "再接続するか、アカウント権限とプランの上限を確認してください。",
  },
}
const epoch = (generation: { current: number }) => generation.current
const invalidate = (generation: { current: number }) => ++generation.current
export function ByosPage() {
  return <Navigate to="/api-providers" replace />
}
export function ByosSettings() {
  const locale = getUiLocale(),
    t = copy[locale === "ko" ? "ko" : locale === "ja" ? "ja" : "en"]
  const config = useAtomValue(configAtom),
    writeConfig = useSetAtom(writeConfigAtom)
  const [session, setSession] = useState<ByosSession>({ state: "disconnected" })
  const [models, setModels] = useState<{ slug: string; display_name: string }[]>([])
  const [model, setModel] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const chromium =
    browser.runtime.getURL("/").startsWith("chrome-extension://") &&
    typeof browser.permissions.request === "function"
  useEffect(() => {
    const current = epoch(generation)
    void sendByosMessage("lingotoriByosSession", undefined)
      .then((next) => {
        if (epoch(generation) === current) setSession(next)
      })
      .catch(() => {})
    return () => {
      invalidate(generation)
    }
  }, [generation])
  async function run(operation: (owner: number) => Promise<void>, owner = invalidate(generation)) {
    setBusy(true)
    setNotice("")
    try {
      await operation(owner)
    } catch {
      if (epoch(generation) === owner) setNotice(t.error)
    } finally {
      if (epoch(generation) === owner) setBusy(false)
    }
  }
  async function refresh(current: number) {
    setModels([])
    setModel("")
    let next: ByosSession
    try {
      next = await sendByosMessage("lingotoriByosSession", undefined)
    } catch {
      if (epoch(generation) === current) setSession({ state: "temporarily-unavailable" })
      throw new Error("session unavailable")
    }
    if (epoch(generation) !== current) return
    setSession(next)
    if (next.state !== "plan-enabled") return
    try {
      const available = await sendByosMessage("lingotoriByosModels", undefined)
      if (epoch(generation) !== current) return
      setModels(available.models)
      setModel((previous) =>
        reconcileModelSelection(
          available.models,
          previous,
          config.providersConfig.find((p) => p.provider === "byos")?.model.customModel,
        ),
      )
    } catch {
      const recovered = await sendByosMessage("lingotoriByosSession", undefined).catch(() => ({
        state: "temporarily-unavailable" as const,
      }))
      if (epoch(generation) !== current) return
      setSession(
        recovered.state === "plan-enabled" ? { state: "temporarily-unavailable" } : recovered,
      )
      throw new Error("models unavailable")
    }
  }
  function signIn() {
    const owner = invalidate(generation)
    // Request immediately inside this future explicit click, before any await.
    const permission = browser.permissions.request({
      permissions: ["declarativeNetRequestWithHostAccess"],
    })
    void run(async () => {
      const granted = await permission
      if (epoch(generation) !== owner) return
      if (!granted) {
        setNotice(t.unavailable)
        return
      }
      setModels([])
      setModel("")
      await sendByosMessage("lingotoriByosAuth", undefined)
      if (epoch(generation) === owner) setNotice(t.pending)
    }, owner)
  }
  const ready =
    session.state === "plan-enabled" && models.some((available) => available.slug === model)
  const buttonClass = "rounded-md border px-3 py-2 text-sm disabled:opacity-50"
  return (
    <ConfigSection title={t.title}>
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <p id="byos-capability" className="text-sm text-muted-foreground">
        {t.unavailable}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!chromium || busy}
          aria-describedby="byos-capability"
          onClick={signIn}
        >
          {t.signIn}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          {t.refresh}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setModels([])
              setModel("")
              await sendByosMessage("lingotoriByosCancelAuth", undefined)
            })
          }
        >
          {t.cancel}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() =>
            void run(async (owner) => {
              setSession({ state: "disconnected" })
              setModels([])
              setModel("")
              const result = await sendByosMessage("lingotoriByosSignout", undefined)
              if (epoch(generation) === owner)
                setNotice(result.remoteRevocationConfirmed ? t.revokedConfirmed : t.revoked)
            })
          }
        >
          {t.signOut}
        </button>
        <a
          className={buttonClass}
          href="https://chatgpt.com/#settings/Usage"
          target="_blank"
          rel="noreferrer"
        >
          {t.usage}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{t.usageHint}</p>
      <p role="status" className="text-sm">
        {session.state === "disconnected"
          ? t.disconnected
          : session.state === "plan-enabled"
            ? t.connected
            : session.state === "identity-only"
              ? t.identity
              : t.blocked}
      </p>
      <label className="flex flex-col gap-2 text-sm">
        {t.model}
        <select
          disabled={!models.length || busy}
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
      <div className="flex flex-wrap gap-2">
        {([undefined, "page", "selection", "dictionary"] as const).map((target) => (
          <button
            key={target ?? "save"}
            type="button"
            className={buttonClass}
            disabled={!ready || busy}
            onClick={() => {
              void writeConfig((current) => buildByosProviderPatch(current, model, target))
              setNotice(t.saved)
            }}
          >
            {target ? t[target] : t.save}
          </button>
        ))}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t.byok}</p>
    </ConfigSection>
  )
}
