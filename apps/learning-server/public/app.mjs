import {
  canonicalNoteId,
  createState,
  saveNote,
  reviewCard,
  mergeStates,
  normalizeLearningLanguage,
  dueCards,
} from "./core.mjs"
const $ = (id) => document.getElementById(id)
const translations = {
  en: {
    retry: "Retry pending save",
    title: "A little practice, every day.",
    intro: "Your words. Your local learning space.",
    secret: "Server sync secret",
    connect: "Unlock learning",
    export: "Export",
    import: "Import",
    lock: "Lock",
    practice: "Practice",
    reveal: "Show meaning",
    again: "Again",
    hard: "Hard",
    good: "Good",
    easy: "Easy",
    add: "Save a word",
    term: "Word or phrase",
    meaning: "Meaning",
    context: "Context",
    language: "Language",
    save: "Save",
    footer: "Simple interval practice · Local server · Keep your export as a backup",
    empty: "All done for now.",
    due: "cards due",
    saved: "Saved",
    error: "Could not complete this action. Check your secret, connection or import file.",
  },
  ko: {
    retry: "저장 재시도",
    title: "매일 조금씩, 나의 언어로.",
    intro: "내 단어를 내 로컬 학습 공간에.",
    secret: "서버 동기화 비밀키",
    connect: "학습 시작",
    export: "내보내기",
    import: "가져오기",
    lock: "잠그기",
    practice: "복습",
    reveal: "뜻 보기",
    again: "다시",
    hard: "어려움",
    good: "좋음",
    easy: "쉬움",
    add: "단어 저장",
    term: "단어 또는 표현",
    meaning: "뜻",
    context: "문맥",
    language: "언어",
    save: "저장",
    footer: "간단한 간격 반복 · 로컬 서버 · 내보내기로 백업하세요",
    empty: "지금 복습할 카드가 없어요.",
    due: "복습할 카드",
    saved: "저장됨",
    error: "완료하지 못했어요. 비밀키, 연결 또는 가져오기 파일을 확인하세요.",
  },
  ja: {
    retry: "保存を再試行",
    title: "毎日少しずつ、自分の言葉に。",
    intro: "自分の単語を、自分のローカル学習空間へ。",
    secret: "サーバー同期シークレット",
    connect: "学習を開く",
    export: "エクスポート",
    import: "インポート",
    lock: "ロック",
    practice: "復習",
    reveal: "意味を見る",
    again: "もう一度",
    hard: "難しい",
    good: "良い",
    easy: "簡単",
    add: "単語を保存",
    term: "単語・表現",
    meaning: "意味",
    context: "文脈",
    language: "言語",
    save: "保存",
    footer: "シンプルな間隔反復 · ローカルサーバー · エクスポートでバックアップ",
    empty: "今の復習は完了です。",
    due: "復習カード",
    saved: "保存しました",
    error: "完了できませんでした。シークレット、接続、ファイルを確認してください。",
  },
}
let secret = "",
  state = createState(),
  current = null,
  busy = false,
  pending = null
const t = (key) => translations[$("locale").value][key]
function render() {
  document.documentElement.lang = $("locale").value
  document.querySelectorAll("[data-t]").forEach((element) => {
    element.textContent = t(element.dataset.t)
  })
  const cards = dueCards(state)
  current = cards[0]
  $("count").textContent = `${cards.length} ${t("due")}`
  $("term").textContent = current
    ? state.notes.find((item) => item.id === current.noteId).term
    : t("empty")
  const note = current && state.notes.find((item) => item.id === current.noteId)
  $("context").textContent = note?.context || ""
  $("meaning").textContent = note?.meaning || ""
  $("meaning").hidden = true
  $("ratings").hidden = true
  $("reveal").hidden = !current
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error("Request failed")
  return (await response.json()).state
}
async function action(fn) {
  if (busy) return
  busy = true
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true
  })
  try {
    await fn()
    $("status").textContent = t("saved")
  } catch {
    $("status").textContent = t("error")
  } finally {
    busy = false
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = Boolean(pending) && button.id !== "retry" && button.id !== "export"
    })
    $("import").disabled = Boolean(pending)
    $("retry").hidden = !pending
  }
}
async function sync(next) {
  pending = next
  state = mergeStates(await api("/api/sync", { state: pending }))
  pending = null
  render()
}
$("retry").onclick = () => action(() => sync(pending))
$("locale").onchange = render
$("connect").onsubmit = (event) => {
  event.preventDefault()
  void action(async () => {
    secret = $("secret").value
    $("secret").value = ""
    state = mergeStates(await api("/api/state"))
    $("login").hidden = true
    $("workspace").hidden = false
    render()
  })
}
$("lock").onclick = () => {
  secret = ""
  state = createState()
  $("workspace").hidden = true
  $("login").hidden = false
  $("status").textContent = ""
  render()
}
$("reveal").onclick = () => {
  $("meaning").hidden = false
  $("ratings").hidden = false
  $("reveal").hidden = true
}
$("ratings").onclick = (event) => {
  const rating = event.target.dataset.rating
  if (rating && current)
    void action(() =>
      sync(
        reviewCard(state, {
          id: crypto.randomUUID(),
          cardId: current.id,
          rating,
          reviewedAt: Date.now(),
        }),
      ),
    )
}
$("note").onsubmit = (event) => {
  event.preventDefault()
  void action(async () => {
    await sync(
      saveNote(state, {
        id: await canonicalNoteId($("new-term").value, $("new-language").value, state),
        term: $("new-term").value,
        meaning: $("new-meaning").value,
        context: $("new-context").value,
        language: normalizeLearningLanguage($("new-language").value),
        sourceUrl: "",
        updatedAt: Date.now(),
      }),
    )
    $("note").reset()
  })
}
$("export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pending || state, null, 2)], { type: "application/json" }),
  )
  const link = document.createElement("a")
  link.href = url
  link.download = "lingotori-learning.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
$("import").onchange = () =>
  void action(async () => {
    const file = $("import").files[0]
    if (!file || file.size > 5_000_000) throw new Error("Invalid file")
    await sync(mergeStates(state, JSON.parse(await file.text())))
    $("import").value = ""
  })
render()

// Refresh only when the visible card changes, preserving a revealed answer.
function refreshDue() {
  if (busy || pending || !secret) return
  const next = dueCards(state)[0]
  if (next?.id !== current?.id) render()
}
setInterval(refreshDue, 30000)
window.addEventListener("focus", refreshDue)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDue()
})
