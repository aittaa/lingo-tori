import type { LearningLocale } from "@/utils/learning/copy"
import type { LearningState, Rating, ReviewEvent } from "@/utils/learning/core"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { browser } from "wxt/browser"
import { learningCopy, learningLocale } from "@/utils/learning/copy"
import { createState, dueCards } from "@/utils/learning/core"
import { sendLearningMessage } from "@/utils/learning/messages"
import "./style.css"

function newReview(cardId: string, rating: Rating): ReviewEvent {
  return { id: crypto.randomUUID(), cardId, rating, reviewedAt: Date.now() }
}
function field(data: FormData, name: string): string {
  const value = data.get(name)
  return typeof value === "string" ? value : ""
}

export function Study() {
  const [locale, setLocale] = useState<LearningLocale>(() => learningLocale(navigator.language))
  const copy = learningCopy[locale]
  const [state, setState] = useState<LearningState>(createState)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [sync, setSync] = useState({ url: "", configured: false })
  const [url, setUrl] = useState("http://127.0.0.1:4317")
  const [secret, setSecret] = useState("")
  const [pendingReview, setPendingReview] = useState<ReviewEvent | null>(null)
  const [pendingRating, setPendingRating] = useState<Rating | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])
  const due = dueCards(state, now)
  const card = pendingReview ? state.cards.find((item) => item.id === pendingReview.cardId) : due[0]
  const note = state.notes.find((item) => item.id === card?.noteId)
  const refresh = async () => {
    const [next, settings] = await Promise.all([
      sendLearningMessage("lingotoriState", undefined),
      sendLearningMessage("lingotoriSyncStatus", undefined),
    ])
    setState(next)
    setSync(settings)
    if (settings.url) setUrl(settings.url)
  }
  useEffect(() => {
    void Promise.all([
      sendLearningMessage("lingotoriState", undefined),
      sendLearningMessage("lingotoriSyncStatus", undefined),
    ])
      .then(([next, settings]) => {
        setState(next)
        setSync(settings)
        if (settings.url) setUrl(settings.url)
      })
      .catch(() => setMessage(copy.error))
      .finally(() => setBusy(false))
  }, [copy.error])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  async function run(action: () => Promise<void>, retry = false) {
    if (busy || (pendingReview && !retry)) return
    setBusy(true)
    setMessage("")
    try {
      await action()
      setMessage(copy.success)
    } catch {
      setMessage(copy.error)
    } finally {
      setBusy(false)
    }
  }
  async function rate(rating: Rating) {
    if (!card || busy) return
    const event = pendingReview ?? newReview(card.id, rating)
    setPendingReview(event)
    setPendingRating(event.rating)
    await run(async () => {
      setState(await sendLearningMessage("lingotoriReview", event))
      setPendingReview(null)
      setPendingRating(null)
      setRevealed(false)
    }, true)
  }
  function exportState() {
    const link = document.createElement("a")
    const blob = URL.createObjectURL(
      new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
    )
    link.href = blob
    link.download = `lingotori-vocabulary-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(blob), 1000)
  }
  return (
    <main>
      <header>
        <a className="brand" href="#">
          LingoTori<span>STUDY</span>
        </a>
        <select
          aria-label="Interface language"
          value={locale}
          onChange={(event) => setLocale(event.target.value as LearningLocale)}
        >
          <option value="en">English</option>
          <option value="ko">한국어</option>
          <option value="ja">日本語</option>
        </select>
      </header>
      <section className="intro">
        <p className="eyebrow">WORDS THAT STAY WITH YOU</p>
        <h1>{copy.title}</h1>
        <p>{copy.subtitle}</p>
      </section>
      <section className="stats">
        <div>
          <strong>{state.notes.length}</strong>
          <span>{copy.words}</span>
        </div>
        <div>
          <strong>{due.length}</strong>
          <span>{copy.due}</span>
        </div>
        <div>
          <strong className="small">{sync.configured ? copy.connected : copy.local}</strong>
          <span>LingoTori · simple-v1</span>
        </div>
      </section>
      <p role="status" aria-live="polite" className="status">
        {message}
      </p>
      <section className="review panel">
        {note ? (
          <>
            <p className="eyebrow">{note.language || copy.words}</p>
            <h2>{note.term}</h2>
            {note.context && <blockquote>{note.context}</blockquote>}
            {revealed ? (
              <>
                <p className="meaning">{note.meaning || "—"}</p>
                {note.sourceUrl && (
                  <a href={note.sourceUrl} target="_blank" rel="noreferrer">
                    {copy.source}
                  </a>
                )}
                <div className="ratings">
                  {(["again", "hard", "good", "easy"] as const).map((rating) => (
                    <button
                      type="button"
                      key={rating}
                      disabled={busy || (!!pendingRating && pendingRating !== rating)}
                      onClick={() => {
                        void rate(rating)
                      }}
                    >
                      {copy[rating]}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || !!pendingRating}
                onClick={() => setRevealed(true)}
              >
                {copy.reveal}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="complete">✓</div>
            <h2>{copy.complete}</h2>
            <p>{copy.empty}</p>
          </>
        )}
      </section>
      <div className="columns">
        <section className="panel">
          <h2>{copy.save}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const form = event.currentTarget
              const data = new FormData(form)
              void run(async () => {
                await sendLearningMessage("lingotoriSave", [
                  {
                    term: field(data, "term"),
                    meaning: field(data, "meaning"),
                    context: field(data, "context"),
                    language: field(data, "language"),
                  },
                ])
                await refresh()
                form.reset()
              })
            }}
          >
            <label>
              {copy.term}
              <input name="term" required maxLength={500} />
            </label>
            <label>
              {copy.meaning}
              <textarea name="meaning" maxLength={5000} />
            </label>
            <label>
              {copy.context}
              <textarea name="context" maxLength={10000} />
            </label>
            <label>
              {copy.language}
              <input name="language" maxLength={40} placeholder="en / ko / ja" />
            </label>
            <button type="submit" className="primary" disabled={busy || !!pendingRating}>
              {copy.save}
            </button>
          </form>
        </section>
        <section className="panel">
          <h2>{copy.words}</h2>
          <div className="tools">
            <button type="button" disabled={busy || !!pendingRating} onClick={exportState}>
              {copy.export}
            </button>
            <label className="file-button">
              {copy.import}
              <input
                aria-label={copy.import}
                disabled={busy || !!pendingRating}
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  if (!file) return
                  void run(async () => {
                    if (file.size > 5_000_000) throw new Error("File too large")
                    setState(
                      await sendLearningMessage("lingotoriImport", JSON.parse(await file.text())),
                    )
                  })
                }}
              />
            </label>
          </div>
          <ul className="words">
            {state.notes
              .slice()
              .reverse()
              .map((item) => (
                <li key={item.id}>
                  <strong>{item.term}</strong>
                  <span>{item.meaning || "—"}</span>
                </li>
              ))}
          </ul>
        </section>
      </div>
      <details className="panel">
        <summary>{copy.settings}</summary>
        <p>{copy.hint}</p>
        <code>{browser.runtime.getURL("/").replace(/\/$/, "")}</code>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await sendLearningMessage("lingotoriConfigureSync", { url, secret })
              setSecret("")
              await refresh()
            })
          }}
        >
          <label>
            {copy.server}
            <input value={url} required onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label>
            {copy.secret}
            <input
              type="password"
              autoComplete="off"
              minLength={24}
              maxLength={1024}
              required
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <div className="tools">
            <button type="submit" disabled={busy || !!pendingRating}>
              {copy.configure}
            </button>
            <button
              type="button"
              disabled={busy || !!pendingRating || !sync.configured}
              onClick={() => {
                void run(async () => {
                  await sendLearningMessage("lingotoriConfigureSync", null)
                  setSecret("")
                  await refresh()
                })
              }}
            >
              {copy.disconnect}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !!pendingRating || !sync.configured}
              onClick={() => {
                void run(async () =>
                  setState(await sendLearningMessage("lingotoriSync", undefined)),
                )
              }}
            >
              {copy.sync}
            </button>
          </div>
        </form>
      </details>
      <footer>LingoTori · Local learning</footer>
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<Study />)
