import type { ByosSession } from "@/utils/byos/service"
import { useAtomValue, useSetAtom } from "jotai"
import { useEffect, useState } from "react"
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
      "Experimental, opt-in integration. You must manually configure a local LingoTori companion before use. Live ChatGPT account sign-in and inference have not been verified. OpenAI tokens stay on your computer.",
    endpoint: "Companion address",
    secret: "Local pairing secret",
    save: "Save connection",
    signIn: "Continue with ChatGPT",
    reconnect: "Reconnect with ChatGPT",
    prerequisites:
      "Start your local companion and save its address and pairing secret before signing in. Then refresh the connection to check account access and discover models.",
    check:
      "Pairing saved; account access has not been checked. Refresh the connection to continue.",
    states: {
      disconnected: "Signed out",
      "plan-enabled": "ChatGPT plan access enabled",
      "identity-only": "Signed in; plan access unavailable",
      restricted: "Account access restricted",
      "limit-reached": "Plan limit reached",
      "reconnect-required": "Sign-in expired; reconnect required",
      "temporarily-unavailable":
        "Companion or models temporarily unavailable; refresh the connection",
    },
    refresh: "Refresh connection and models",
    signOut: "Sign out of ChatGPT",
    forget: "Forget local pairing",
    model: "Available model",
    choose: "Choose a model",
    activate: "Save BYOS provider",
    page: "Use for page translation",
    selection: "Use for selection translation",
    dictionary: "Use for dictionary and sentence analysis",
    hint: "Start the companion with this extension origin in its allowlist. Copy the secret from its protected bridge.json file; never paste an OpenAI token here.",
    saved: "Saved",
    error:
      "Connection failed. Check the companion, pairing, account permission, and plan limits. No API-key fallback was used.",
    ready: "Pairing configured",
    none: "Companion setup required",
    state: "Connection",
    enabled: "BYOS provider model",
    revoked:
      "Signed out locally; remote revocation was not confirmed. Disconnect the app in ChatGPT Settings.",
    usage: "Manage ChatGPT usage",
    pending: "Working…",
  },
  ko: {
    title: "ChatGPT로 로그인 · 실험적 BYOS",
    intro:
      "직접 선택해 설정하는 실험적 연동입니다. 사용하려면 로컬 LingoTori 컴패니언을 수동으로 설정해야 합니다. 실제 ChatGPT 계정 로그인과 추론은 검증되지 않았습니다. OpenAI 토큰은 컴퓨터에 보관됩니다.",
    endpoint: "컴패니언 주소",
    secret: "로컬 연결 비밀키",
    save: "연결 저장",
    signIn: "ChatGPT로 계속",
    reconnect: "ChatGPT 다시 연결",
    prerequisites:
      "로그인 전에 로컬 컴패니언을 실행하고 주소와 연결 비밀키를 저장하세요. 이후 연결을 새로고침하여 계정 권한과 사용 가능한 모델을 확인하세요.",
    check: "연결 정보가 저장되었지만 계정 권한은 확인되지 않았습니다. 연결을 새로고침하세요.",
    states: {
      disconnected: "로그아웃됨",
      "plan-enabled": "ChatGPT 요금제 사용 권한 있음",
      "identity-only": "로그인됨; 요금제 사용 권한 없음",
      restricted: "계정 사용 제한",
      "limit-reached": "요금제 한도 도달",
      "reconnect-required": "로그인 만료; 다시 연결 필요",
      "temporarily-unavailable": "컴패니언 또는 모델을 사용할 수 없습니다. 연결을 새로고침하세요",
    },
    refresh: "연결 및 모델 새로고침",
    signOut: "ChatGPT 로그아웃",
    forget: "로컬 연결 삭제",
    model: "사용 가능한 모델",
    choose: "모델 선택",
    activate: "BYOS 제공자 저장",
    page: "페이지 번역에 사용",
    selection: "선택 영역 번역에 사용",
    dictionary: "사전 및 문장 분석에 사용",
    hint: "컴패니언 허용 목록에 아래 확장 프로그램 출처를 등록하세요. 보호된 bridge.json의 비밀키를 복사하세요. OpenAI 토큰을 입력하지 마세요.",
    saved: "저장됨",
    error:
      "연결에 실패했습니다. 컴패니언, 연결 키, 계정 권한 및 요금제 한도를 확인하세요. API 키로 자동 전환하지 않았습니다.",
    ready: "연결 설정됨",
    none: "컴패니언 설정 필요",
    state: "연결",
    enabled: "BYOS 제공자 모델",
    revoked:
      "로컬 로그아웃은 완료했으나 원격 해제를 확인하지 못했습니다. ChatGPT 설정에서 앱 연결을 해제하세요.",
    usage: "ChatGPT 사용량 관리",
    pending: "처리 중…",
  },
  ja: {
    title: "ChatGPT でログイン · 実験的な BYOS",
    intro:
      "利用者が選択して設定する実験的な連携です。利用にはローカルの LingoTori コンパニオンを手動で設定する必要があります。実際の ChatGPT アカウントへのログインと推論は未検証です。OpenAI トークンはコンピューターに保存されます。",
    endpoint: "コンパニオンのアドレス",
    secret: "ローカル接続シークレット",
    save: "接続を保存",
    signIn: "ChatGPT で続行",
    reconnect: "ChatGPT に再接続",
    prerequisites:
      "ログイン前にローカルのコンパニオンを起動し、アドレスと接続シークレットを保存してください。その後、接続を更新してアカウントの権限と利用可能なモデルを確認してください。",
    check: "接続情報は保存済みですが、アカウントの権限は未確認です。接続を更新してください。",
    states: {
      disconnected: "ログアウト済み",
      "plan-enabled": "ChatGPT プランの利用権限あり",
      "identity-only": "ログイン済み; プラン利用権限なし",
      restricted: "アカウント利用制限",
      "limit-reached": "プラン上限に到達",
      "reconnect-required": "ログイン期限切れ; 再接続が必要",
      "temporarily-unavailable": "コンパニオンまたはモデルを利用できません。接続を更新してください",
    },
    refresh: "接続とモデルを更新",
    signOut: "ChatGPT からログアウト",
    forget: "ローカル接続を削除",
    model: "利用可能なモデル",
    choose: "モデルを選択",
    activate: "BYOS プロバイダーを保存",
    page: "ページ翻訳に使用",
    selection: "選択範囲の翻訳に使用",
    dictionary: "辞書と文の分析に使用",
    hint: "以下の拡張機能オリジンをコンパニオンの許可リストに登録してください。保護された bridge.json のシークレットをコピーし、OpenAI トークンは入力しないでください。",
    saved: "保存しました",
    error:
      "接続できません。コンパニオン、接続キー、権限、プランの上限を確認してください。API キーへの自動切り替えは行っていません。",
    ready: "接続設定済み",
    none: "コンパニオンの設定が必要",
    state: "接続",
    enabled: "BYOS プロバイダーモデル",
    revoked:
      "ローカルではログアウトしましたが、リモートでの解除を確認できません。ChatGPT 設定からアプリを解除してください。",
    usage: "ChatGPT 使用量を管理",
    pending: "処理中…",
  },
}
/** Keep older bookmarks directed to the unified provider settings. */
export function ByosPage() {
  return <Navigate to="/api-providers" replace />
}

export function ByosSettings() {
  const locale = getUiLocale(),
    t = copy[locale === "ko" ? "ko" : locale === "ja" ? "ja" : "en"]
  const config = useAtomValue(configAtom),
    writeConfig = useSetAtom(writeConfigAtom)
  const [endpoint, setEndpoint] = useState(""),
    [secret, setSecret] = useState("")
  const [configured, setConfigured] = useState(false),
    [session, setSession] = useState<ByosSession>()
  const [models, setModels] = useState<{ slug: string; display_name: string }[]>([]),
    [model, setModel] = useState("")
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("")
  const provider = config.providersConfig.find((p) => p.provider === "byos")
  useEffect(() => {
    void sendByosMessage("lingotoriByosStatus", undefined)
      .then((status) => {
        setConfigured(status.configured)
        setEndpoint(status.endpoint)
      })
      .catch(() => setNotice(t.error))
  }, [t.error])
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setNotice("")
    try {
      await work()
    } catch {
      setNotice(t.error)
    } finally {
      setBusy(false)
    }
  }
  async function refresh() {
    setSession(undefined)
    setModels([])
    let next: ByosSession
    try {
      next = await sendByosMessage("lingotoriByosSession", undefined)
    } catch (error) {
      setSession({ state: "temporarily-unavailable" })
      setModel("")
      throw error
    }
    setSession(next)
    if (next.state !== "plan-enabled") {
      setModel("")
      return
    }
    try {
      const result = await sendByosMessage("lingotoriByosModels", undefined)
      setModels(result.models)
      setModel((current) =>
        reconcileModelSelection(
          result.models,
          current,
          provider?.provider === "byos" ? provider.model.customModel : null,
        ),
      )
    } catch (error) {
      setModel("")
      // Discovery can change the companion's authorization or limit state.
      // Read it again so recovery offers the appropriate next action.
      try {
        const latest = await sendByosMessage("lingotoriByosSession", undefined)
        setSession(
          latest.state === "plan-enabled"
            ? { ...latest, state: "temporarily-unavailable" }
            : latest,
        )
      } catch {
        setSession({ state: "temporarily-unavailable" })
      }
      throw error
    }
  }
  async function activate(target?: "page" | "selection" | "dictionary") {
    if (
      !configured ||
      session?.state !== "plan-enabled" ||
      !model ||
      !models.some((m) => m.slug === model)
    )
      return
    await writeConfig((current) => buildByosProviderPatch(current, model, target))
    setNotice(t.saved)
  }
  const buttonClass = "rounded-lg border px-4 py-2 text-sm disabled:opacity-50 hover:bg-muted"
  return (
    <ConfigSection id="byos" title={t.title}>
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <p className="text-sm">{t.prerequisites}</p>
      <section className="space-y-4 rounded-xl border p-5">
        <p className="text-sm text-muted-foreground">{t.hint}</p>
        <code className="block text-xs break-all">
          {browser.runtime.getURL("/").replace(/\/$/, "")}
        </code>
        <label className="block space-y-2">
          <span>{t.endpoint}</span>
          <input
            className="block w-full rounded border p-2"
            value={endpoint}
            placeholder="http://127.0.0.1:PORT"
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label className="block space-y-2">
          <span>{t.secret}</span>
          <input
            className="block w-full rounded border p-2"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !endpoint || !secret}
            onClick={() =>
              void run(async () => {
                await sendByosMessage("lingotoriByosConfigure", { endpoint, secret })
                setSecret("")
                setConfigured(true)
                setSession(undefined)
                setModels([])
                setModel("")
                setNotice(t.saved)
              })
            }
          >
            {t.save}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={
              busy || !configured || !session || session.state === "temporarily-unavailable"
            }
            onClick={() =>
              void run(async () => {
                await sendByosMessage("lingotoriByosAuth", undefined)
              })
            }
          >
            {session?.state === "reconnect-required" ? t.reconnect : t.signIn}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !configured}
            onClick={() => void run(refresh)}
          >
            {t.refresh}
          </button>
        </div>
        <p className="text-sm">
          {t.state}: {session ? t.states[session.state] : configured ? t.check : t.none}{" "}
          {session?.account?.email}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !configured}
            onClick={() =>
              void run(async () => {
                const result = await sendByosMessage("lingotoriByosSignout", undefined)
                setSession(result)
                setModels([])
                setModel("")
                if (!result.remoteRevocationConfirmed) setNotice(t.revoked)
              })
            }
          >
            {t.signOut}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !configured}
            onClick={() =>
              void run(async () => {
                await sendByosMessage("lingotoriByosConfigure", null)
                setConfigured(false)
                setSession(undefined)
                setModels([])
                setModel("")
                setSecret("")
              })
            }
          >
            {t.forget}
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
      </section>
      <section className="space-y-4 rounded-xl border p-5">
        <label className="block space-y-2">
          <span>{t.model}</span>
          <select
            className="block w-full rounded border p-2"
            value={model}
            disabled={busy || !configured || session?.state !== "plan-enabled" || !models.length}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">{t.choose}</option>
            {models.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.display_name}
              </option>
            ))}
          </select>
        </label>
        {provider?.provider === "byos" && (
          <p className="text-sm text-muted-foreground">
            {t.enabled}: {provider.model.customModel}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(
            [
              [undefined, t.activate],
              ["page", t.page],
              ["selection", t.selection],
              ["dictionary", t.dictionary],
            ] as const
          ).map(([target, label]) => (
            <button
              type="button"
              key={label}
              className={buttonClass}
              disabled={
                busy ||
                !configured ||
                session?.state !== "plan-enabled" ||
                !models.some((item) => item.slug === model)
              }
              onClick={() => void run(() => activate(target))}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <p aria-live="polite" role="status">
        {busy ? t.pending : notice}
      </p>
    </ConfigSection>
  )
}
