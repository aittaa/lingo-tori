// Independently authored LingoTori learning data and simple interval scheduler.
export const SCHEMA_VERSION = 1
export const SCHEDULER_VERSION = "simple-v1"
const DAY = 86400000
const fields = (value, allowed) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("Invalid fields")
}
function string(value, max, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new Error("Invalid text")
  return value
}
function id(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid ID")
  return value
}
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8e15)
    throw new Error("Invalid timestamp")
  return value
}
export function validateNote(note) {
  fields(note, ["id", "term", "meaning", "context", "language", "sourceUrl", "updatedAt"])
  const result = {
    id: id(note.id),
    term: string(note.term, 500, true),
    meaning: string(note.meaning ?? "", 5000),
    context: string(note.context ?? "", 10000),
    language: string(note.language ?? "", 40),
    sourceUrl: string(note.sourceUrl ?? "", 2000),
    updatedAt: time(note.updatedAt),
  }
  if (result.sourceUrl) {
    const url = new URL(result.sourceUrl)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Source URLs must be HTTP(S) without credentials, queries or fragments")
  }
  return result
}
export function validateReview(event) {
  fields(event, ["id", "cardId", "rating", "reviewedAt"])
  if (!["again", "hard", "good", "easy"].includes(event.rating)) throw new Error("Invalid rating")
  return {
    id: id(event.id),
    cardId: id(event.cardId),
    rating: event.rating,
    reviewedAt: time(event.reviewedAt),
  }
}
export function createState() {
  return { schemaVersion: SCHEMA_VERSION, notes: [], cards: [], reviews: [] }
}
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
function rebuild(notes, reviews) {
  const cards = new Map(
    notes.map((note) => [
      note.id,
      {
        id: note.id,
        noteId: note.id,
        dueAt: 0,
        intervalDays: 0,
        repetitions: 0,
        lapses: 0,
        lastReviewedAt: null,
        schedulerVersion: SCHEDULER_VERSION,
      },
    ]),
  )
  for (const event of reviews) {
    const card = cards.get(event.cardId)
    if (!card) throw new Error("Review refers to unknown card")
    const previous = card.intervalDays
    card.intervalDays =
      event.rating === "again"
        ? 0
        : event.rating === "hard"
          ? Math.max(1, Math.round(previous * 1.2))
          : event.rating === "good"
            ? Math.max(1, Math.round(previous * 2))
            : Math.max(3, Math.round(previous * 3))
    card.intervalDays = Math.min(36500, card.intervalDays)
    card.dueAt = Math.min(
      8e15,
      event.reviewedAt + (event.rating === "again" ? 600000 : card.intervalDays * DAY),
    )
    card.repetitions += 1
    card.lapses += Number(event.rating === "again")
    card.lastReviewedAt = event.reviewedAt
  }
  return { schemaVersion: SCHEMA_VERSION, notes, cards: [...cards.values()], reviews }
}
export function mergeStates(...states) {
  const notes = new Map(),
    reviews = new Map()
  for (const state of states) {
    fields(state, ["schemaVersion", "notes", "cards", "reviews"])
    if (
      state.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(state.notes) ||
      !Array.isArray(state.reviews) ||
      !Array.isArray(state.cards) ||
      state.notes.length > 10000 ||
      state.cards.length > 10000 ||
      state.reviews.length > 100000
    )
      throw new Error("Invalid state or unsupported schema")
    for (const value of state.notes) {
      const note = validateNote(value),
        previous = notes.get(note.id)
      if (
        !previous ||
        note.updatedAt > previous.updatedAt ||
        (note.updatedAt === previous.updatedAt && JSON.stringify(note) > JSON.stringify(previous))
      )
        notes.set(note.id, note)
    }
    for (const value of state.reviews) {
      const event = validateReview(value),
        previous = reviews.get(event.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(event))
        throw new Error("Review ID conflict")
      reviews.set(event.id, event)
    }
  }
  if (notes.size > 10000 || reviews.size > 100000) throw new Error("State limit exceeded")
  return rebuild(
    [...notes.values()].sort((a, b) => compare(a.id, b.id)),
    [...reviews.values()].sort((a, b) => a.reviewedAt - b.reviewedAt || compare(a.id, b.id)),
  )
}
export function saveNote(state, note) {
  return mergeStates(state, { ...createState(), notes: [note] })
}
export function reviewCard(state, event) {
  return mergeStates(state, { ...createState(), reviews: [event] })
}
export function dueCards(state, now = Date.now()) {
  time(now)
  return mergeStates(state)
    .cards.filter((card) => card.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt || compare(a.id, b.id))
}

// Intl canonicalizes standardized language aliases without a vendored language dataset.
// These three macrolanguage mappings match the extension's supported provider tags.
const vocabularyLanguageAliases = { fuv: "ff", zlm: "ms", qug: "qu" }
export function normalizeLearningLanguage(language) {
  const value = language.trim()
  if (!value) return "und"
  try {
    const locale = new Intl.Locale(value)
    const code = vocabularyLanguageAliases[locale.language] ?? locale.language
    if (code === "zh") return locale.maximize().script === "Hant" ? "zh-Hant" : "zh"
    return code + (locale.script ? `-${locale.script}` : "")
  } catch {
    return value.toLowerCase()
  }
}

// Imported matching identities remain authoritative to preserve review references.
export async function canonicalNoteId(term, language, state = createState()) {
  const normalized = term.normalize("NFC").trim()
  const code = normalizeLearningLanguage(language)
  const existing = state.notes.find(
    (note) =>
      note.term.normalize("NFC").trim() === normalized &&
      normalizeLearningLanguage(note.language) === code,
  )
  if (existing) return existing.id
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([normalized, code])),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
