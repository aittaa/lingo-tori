import type { ByosSession } from "@/utils/byos/service"
import { useAtomValue, useSetAtom } from "jotai"
import { useEffect, useState } from "react"
import { browser } from "wxt/browser"
import { configAtom, writeConfigAtom } from "@/utils/atoms/config"
import { sendByosMessage } from "@/utils/byos/messages"
import { getUiLocale } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { reconcileModelSelection } from "./model-selection"
const copy = {
  en: {
    title: "ChatGPT plan (BYOS)",
    intro:
      "Use your ChatGPT plan through your local LingoTori companion. OpenAI tokens stay on your computer. Hosted support requires separate approval.",
    endpoint: "Companion address",
    secret: "Local pairing secret",
    save: "Save connection",
    signIn: "Continue with ChatGPT",
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
    none: "Not paired",
    state: "Connection",
    enabled: "BYOS provider model",
    revoked:
      "Signed out locally; remote revocation was not confirmed. Disconnect the app in ChatGPT Settings.",
    usage: "Manage ChatGPT usage",
    pending: "Working…",
  },
  ko: {
    title: "ChatGPT 요금제 (BYOS)",
    intro:
      "로컬 LingoTori 컴패니언으로 ChatGPT 요금제를 사용합니다. OpenAI 토큰은 컴퓨터에 보관됩니다. 호스팅 지원에는 별도 승인이 필요합니다.",
    endpoint: "컴패니언 주소",
    secret: "로컬 연결 비밀키",
    save: "연결 저장",
    signIn: "ChatGPT로 계속",
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
    none: "연결되지 않음",
    state: "연결",
    enabled: "BYOS 제공자 모델",
    revoked:
      "로컬 로그아웃은 완료했으나 원격 해제를 확인하지 못했습니다. ChatGPT 설정에서 앱 연결을 해제하세요.",
    usage: "ChatGPT 사용량 관리",
    pending: "처리 중…",
  },
  ja: {
    title: "ChatGPT プラン (BYOS)",
    intro:
      "ローカルの LingoTori コンパニオンで ChatGPT プランを利用します。OpenAI トークンはコンピューターに保存されます。ホスティングには別途承認が必要です。",
    endpoint: "コンパニオンのアドレス",
    secret: "ローカル接続シークレット",
    save: "接続を保存",
    signIn: "ChatGPT で続行",
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
    none: "未接続",
    state: "接続",
    enabled: "BYOS プロバイダーモデル",
    revoked:
      "ローカルではログアウトしましたが、リモートでの解除を確認できません。ChatGPT 設定からアプリを解除してください。",
    usage: "ChatGPT 使用量を管理",
    pending: "処理中…",
  },
}
export function ByosPage() {
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
    const next = await sendByosMessage("lingotoriByosSession", undefined)
    setSession(next)
    if (next.state === "plan-enabled") {
      const result = await sendByosMessage("lingotoriByosModels", undefined)
      setModels(result.models)
      setModel((current) =>
        reconcileModelSelection(
          result.models,
          current,
          provider?.provider === "byos" ? provider.model.customModel : null,
        ),
      )
    } else {
      setModels([])
      setModel("")
    }
  }
  async function activate(target?: "page" | "selection" | "dictionary") {
    if (!model || !models.some((m) => m.slug === model)) return
    await writeConfig((current) => {
      const existing = current.providersConfig.find((p) => p.provider === "byos")
      const id = existing?.id || "lingotori-byos"
      const next = {
        id,
        name: "ChatGPT plan (BYOS)",
        enabled: true,
        provider: "byos" as const,
        model: {
          model: "use-custom-model" as const,
          isCustomModel: true as const,
          customModel: model,
        },
      }
      return {
        providersConfig: existing
          ? current.providersConfig.map((p) =>
              p.id === id ? (target ? { ...p, enabled: true } : next) : p,
            )
          : [...current.providersConfig, next],
        ...(target === "page"
          ? { pageTranslation: { ...current.pageTranslation, providerId: id } }
          : {}),
        ...(target === "selection"
          ? {
              selectionToolbar: {
                ...current.selectionToolbar,
                features: {
                  ...current.selectionToolbar.features,
                  translate: { ...current.selectionToolbar.features.translate, providerId: id },
                },
              },
            }
          : {}),
        ...(target === "dictionary"
          ? {
              selectionToolbar: {
                ...current.selectionToolbar,
                builtInActions: {
                  ...current.selectionToolbar.builtInActions,
                  dictionary: {
                    ...current.selectionToolbar.builtInActions.dictionary,
                    providerId: id,
                  },
                  sentenceAnalysis: {
                    ...current.selectionToolbar.builtInActions.sentenceAnalysis,
                    providerId: id,
                  },
                },
              },
            }
          : {}),
      }
    })
    setNotice(t.saved)
  }
  const buttonClass = "rounded-lg border px-4 py-2 text-sm disabled:opacity-50 hover:bg-muted"
  return (
    <PageLayout title={t.title} description={t.intro} innerClassName="space-y-6">
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
            disabled={busy || !configured}
            onClick={() =>
              void run(async () => {
                await sendByosMessage("lingotoriByosAuth", undefined)
              })
            }
          >
            {t.signIn}
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
          {t.state}: {session?.state || (configured ? t.ready : t.none)} {session?.account?.email}
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
            disabled={busy || !models.length}
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
              disabled={busy || !model}
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
    </PageLayout>
  )
}
