import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  canonicalNoteId,
  createState,
  saveNote,
  reviewCard,
  mergeStates,
  normalizeLearningLanguage,
  dueCards,
} from "./index.mjs"
const note = {
  id: "note-1",
  term: "bird",
  meaning: "새",
  context: "A bird sings.",
  language: "en",
  sourceUrl: "https://example.org/page",
  updatedAt: 1000,
}
test("idempotent save/review and deterministic replay across devices", () => {
  const base = saveNote(createState(), note)
  const event = { id: "review-a", cardId: note.id, rating: "good", reviewedAt: 2000 }
  const a = reviewCard(base, event),
    b = reviewCard(base, { ...event, id: "review-b", rating: "easy", reviewedAt: 3000 })
  assert.deepEqual(saveNote(base, note), base)
  assert.deepEqual(reviewCard(a, event), a)
  assert.deepEqual(mergeStates(a, b), mergeStates(b, a))
  assert.equal(mergeStates(a, b).cards[0].intervalDays, 3)
  assert.equal(dueCards(a, 2000).length, 0)
  assert.equal(dueCards(base, 0).length, 1)
  assert.equal(base.reviews.length, 0)
})
test("conflicts converge and conflicting immutable IDs fail", () => {
  const a = saveNote(createState(), note),
    b = saveNote(createState(), { ...note, meaning: "鳥" })
  assert.deepEqual(mergeStates(a, b), mergeStates(b, a))
  const event = { id: "r", cardId: note.id, rating: "again", reviewedAt: 2000 }
  assert.throws(() => reviewCard(reviewCard(a, event), { ...event, rating: "easy" }), /conflict/)
  assert.equal(reviewCard(a, event).cards[0].dueAt, 602000)
})
test("reject malformed data, secret fields, unsafe source URLs and orphan reviews", () => {
  for (const patch of [
    { token: "fixture" },
    { sourceUrl: "https://example.org/?token=fixture" },
    { sourceUrl: "javascript:alert(1)" },
    { updatedAt: NaN },
  ])
    assert.throws(() => saveNote(createState(), { ...note, ...patch }))
  assert.throws(() =>
    reviewCard(createState(), { id: "r", cardId: "absent", rating: "good", reviewedAt: 0 }),
  )
  assert.throws(() => mergeStates({ ...createState(), schemaVersion: 2 }))
})
test("bounds all state arrays and derives cards rather than trusting supplied schedules", () => {
  assert.throws(
    () => mergeStates({ ...createState(), cards: Array(10001).fill({}) }),
    /Invalid state/,
  )
  const base = saveNote(createState(), note)
  assert.deepEqual(mergeStates({ ...base, cards: [{ id: note.id, dueAt: 8e15 }] }), base)
  const first = { id: "a", cardId: note.id, rating: "easy", reviewedAt: 2000 }
  const second = { ...first, id: "b", rating: "again" }
  const merged = mergeStates(reviewCard(base, second), reviewCard(base, first))
  assert.equal(merged.cards[0].dueAt, 602000)
  assert.equal(merged.cards[0].repetitions, 2)
  assert.deepEqual(mergeStates(merged, merged), merged)
})

test("canonical note IDs share normalized identity and preserve imported scheduling IDs", async () => {
  assert.equal(await canonicalNoteId(" café ", "fra"), await canonicalNoteId("cafe\u0301", "fra"))
  assert.notEqual(await canonicalNoteId("pain", "fra"), await canonicalNoteId("pain", "eng"))
  assert.equal(
    await canonicalNoteId("猫", "jpn"),
    "f87bb9ceb02d4b8bb8b5df94612d9991127fee475083070ea9e07c50b305503c",
  )
  const previous = reviewCard(saveNote(createState(), note), {
    id: "old-review",
    cardId: note.id,
    rating: "good",
    reviewedAt: 2000,
  })
  const identity = await canonicalNoteId("bird", "en", previous)
  assert.equal(identity, "note-1")
  const updated = saveNote(previous, { ...note, id: identity, meaning: "updated", updatedAt: 3000 })
  assert.equal(updated.notes.length, 1)
  assert.deepEqual(updated.cards, previous.cards)
  assert.deepEqual(updated.reviews, previous.reviews)
})

test("supported short-code aliases converge while script distinctions and legacy IDs survive", async () => {
  const catalog = readFileSync(new URL("../../src/lib/languages/index.ts", import.meta.url), "utf8")
  const mapping = catalog.split("const shortCodes = {")[1].split("} as const")[0]
  let checked = 0
  for (const match of mapping.matchAll(/(?:"([^"]+)"|(\w+)): "([^"]+)"/g)) {
    assert.equal(
      normalizeLearningLanguage(match[1] || match[2]),
      normalizeLearningLanguage(match[3]),
      `alias ${match[1] || match[2]}/${match[3]}`,
    )
    checked++
  }
  assert.ok(checked > 100)
  assert.equal(await canonicalNoteId("cat", "eng"), await canonicalNoteId("cat", "en"))
  assert.equal(await canonicalNoteId("猫", "jpn"), await canonicalNoteId("猫", "ja"))
  assert.equal(await canonicalNoteId("말", "kor"), await canonicalNoteId("말", "ko"))
  assert.notEqual(await canonicalNoteId("字", "cmn"), await canonicalNoteId("字", "cmn-Hant"))
  const legacy = reviewCard(
    saveNote(createState(), { ...note, id: "legacy-eng", term: "cat", language: "eng" }),
    { id: "legacy-review", cardId: "legacy-eng", rating: "good", reviewedAt: 2000 },
  )
  assert.equal(await canonicalNoteId("cat", "en", legacy), "legacy-eng")
})
