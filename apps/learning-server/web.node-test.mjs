import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"
import * as core from "../../packages/learning-core/index.mjs"
test("web timer and focus expose newly due cards without resetting a revealed current card", async () => {
  let now = 1000
  const elements = new Map()
  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, { value: id === "locale" ? "en" : "", hidden: false, textContent: "" })
    return elements.get(id)
  }
  const listeners = {},
    timers = []
  const context = createContext({
    ...core,
    dueCards: (state) => core.dueCards(state, now),
    Date: class extends Date {
      static now() {
        return now
      }
    },
    document: {
      getElementById: get,
      documentElement: {},
      querySelectorAll: () => [],
      addEventListener: (type, fn) => {
        listeners[type] = fn
      },
      hidden: false,
    },
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn
      },
    },
    setInterval: (fn) => {
      timers.push(fn)
    },
    setTimeout: () => {},
    crypto,
  })
  const source = (await readFile(new URL("./public/app.mjs", import.meta.url), "utf8")).replace(
    /^import[\s\S]*?from "\.\/core\.mjs"\n/,
    "",
  )
  runInContext(source, context)
  const note = {
    id: "A",
    term: "A",
    language: "eng",
    meaning: "meaning",
    context: "",
    sourceUrl: "",
    updatedAt: 1,
  }
  context.fixture = core.reviewCard(core.saveNote(core.createState(), note), {
    id: "r1",
    cardId: "A",
    rating: "again",
    reviewedAt: now,
  })
  runInContext('secret = "fixture"; state = fixture; render()', context)
  assert.equal(get("term").textContent, "All done for now.")
  now += 600000
  timers[0]()
  assert.equal(get("term").textContent, "A")
  get("reveal").onclick()
  timers[0]()
  assert.equal(get("meaning").hidden, false)
  runInContext("current = null", context)
  listeners.focus()
  assert.equal(get("term").textContent, "A")
})
