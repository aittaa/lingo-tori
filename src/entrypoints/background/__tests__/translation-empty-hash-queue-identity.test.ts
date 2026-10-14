import type { ProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR, DEFAULT_BATCH_TRANSLATE_PROMPT } from "@/utils/constants/prompt"

/**
 * INT-01: a request that arrives with an EMPTY `hash` must never be folded into a different
 * request by either queue.
 *
 * An empty hash means "do not cache this" (the handlers' `hash &&` gates), and `BatchQueue`
 * already skips its own dedup for a falsy key. But the work a batch hands to `RequestQueue` is
 * keyed by `Sha256Hex(...members' hashes)`, and the per-item fallback and the pure-API path pass
 * the hash straight through, so every empty-hash request shared one `RequestQueue` key. That
 * queue returns the promise of any waiting or executing task with an equal key and never runs
 * the second thunk, so a second, DIFFERENT text received the first text's translation.
 *
 * The contract these tests pin: an empty hash is never cached AND never deduped with a different
 * request. Every case sends two different texts X and Y with hash "" and asserts each caller
 * gets its OWN translation from its OWN provider call.
 *
 * Everything between the message bus and the SDK/transport is production code: the page and
 * subtitle handlers, `BatchQueue`, `RequestQueue`, `executeTranslate`, `aiTranslate`, the DeepL
 * and DeepLX adapters and the prompt builders. Only the message transport, the cache DB (an
 * in-memory Map), the SDK and `fetch` are replaced; `fetch` serves nothing but the two
 * synthetic DeepL/DeepLX hosts, so no live call is possible.
 *
 * A "snapshot" request carries a `promptTemplate`; a "legacy" request does not and resolves the
 * stored prompt at execution. They differ in batch key, so they never share a batch, which is
 * what puts X and Y into two separate `RequestQueue` tasks.
 *
 * `control:` and `invariant:` tests pass on the unfixed code and guard behaviour that must not
 * move.
 */

type Kind = "snapshot" | "legacy"
type Marker = "s" | "l"

interface GenerateOptions {
  instructions: string
  prompt: string
}

type Handler = (message: { data: Record<string, unknown>; sender?: unknown }) => Promise<string>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => Promise<any>>(),
  cache: new Map<string, { key: string; translation: string; createdAt: Date }>(),
  cacheReads: [] as string[],
  cacheWrites: [] as { key: string; translation: string }[],
  holds: new Map<string, { promise: Promise<void>; open: () => void }>(),
  failOnce: new Set<string>(),
  apiCalls: [] as string[],
  mismatchBatchCalls: { value: false },
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
  generateText: vi.fn<(options: GenerateOptions) => Promise<{ text: string }>>(),
  fetch: vi.fn<typeof fetch>(),
  createOpenAICompatible: vi.fn<(settings: Record<string, unknown>) => unknown>((settings) => ({
    languageModel: (modelId: string) => ({ ...settings, modelId }),
  })),
}))

vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) => {
    mocks.handlers.set(name, handler)
  },
}))
vi.mock("../config", () => ({ ensureInitializedConfig: mocks.ensureInitializedConfig }))
vi.mock("../translation-context-summary", () => ({
  getOrGenerateTranslationContextSummary: vi.fn<() => Promise<null>>(),
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: mocks.putBatchRequestRecord,
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: {
      get: async (key: string) => {
        mocks.cacheReads.push(key)
        return mocks.cache.get(key)
      },
      put: async (row: { key: string; translation: string; createdAt: Date }) => {
        mocks.cacheWrites.push({ key: row.key, translation: row.translation })
        mocks.cache.set(row.key, row)
      },
      delete: async (key: string) => {
        mocks.cache.delete(key)
      },
    },
  },
}))
vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: vi.fn<() => void>(), close: vi.fn<() => void>() },
}))
vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))
vi.mock("ai", () => ({ generateText: mocks.generateText }))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))

const JOINED = `\n\n${BATCH_SEPARATOR}\n\n`

const X = "first-paragraph"
const Y = "second-paragraph"
const BLOCK = "blocker-paragraph"
const BLOCK_HASH = "blocker-hash"

/** What a snapshot-carrying sender posts. The marker tells the mocked SDK which prompt ran. */
const SNAPSHOT_TEMPLATE = {
  systemPrompt: "MARK-SNAP: translate into {{targetLanguage}}.",
  prompt: "{{input}}",
}

/** The prompt a legacy request resolves from the stored selection at execution. */
const STORED_PROMPT = {
  id: "stored-prompt",
  name: "Stored prompt",
  systemPrompt: "MARK-LEGACY: translate into {{targetLanguage}}.",
  prompt: "{{input}}",
}
const customPromptsConfig = { promptId: STORED_PROMPT.id, patterns: [STORED_PROMPT] }

const MARKER: Record<Kind, Marker> = { snapshot: "s", legacy: "l" }

const llmProvider: ProviderConfig = {
  id: "empty-hash-provider",
  name: "Empty hash provider",
  provider: "openai-compatible",
  enabled: true,
  baseURL: "https://empty-hash.example/v1",
  apiKey: "synthetic-key",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "empty-hash-model" },
}

const deeplx: ProviderConfig = {
  id: "deeplx-empty-hash",
  name: "DeepLX",
  enabled: true,
  provider: "deeplx",
  baseURL: "https://deeplx.example.test/translate",
}

const deepl: ProviderConfig = {
  id: "deepl-empty-hash",
  name: "DeepL",
  enabled: true,
  provider: "deepl",
  apiKey: "synthetic-key:fx",
}

type ProviderRef = { kind: "local"; config: ProviderConfig }
const llmRef: ProviderRef = { kind: "local", config: llmProvider }

const PURE_API: { label: string; ref: ProviderRef }[] = [
  { label: "DeepLX", ref: { kind: "local", config: deeplx } },
  { label: "DeepL", ref: { kind: "local", config: deepl } },
]

interface QueueOverrides {
  requestQueueConfig?: { rate: number; capacity: number }
  batchQueueConfig?: { maxCharactersPerBatch: number; maxItemsPerBatch: number }
}

function queueConfig(overrides: QueueOverrides = {}) {
  const queues = {
    providerId: llmProvider.id,
    requestQueueConfig: overrides.requestQueueConfig ?? { rate: 10, capacity: 10 },
    batchQueueConfig: overrides.batchQueueConfig ?? {
      maxCharactersPerBatch: 1000,
      maxItemsPerBatch: 10,
    },
  }
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [llmProvider],
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, ...queues, customPromptsConfig },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, ...queues, customPromptsConfig },
  }
}

/** A rate limiter with a single token: one request runs, the next one waits about a second. */
const ONE_TOKEN: QueueOverrides = { requestQueueConfig: { rate: 1, capacity: 1 } }
const ONE_ITEM_BATCHES: QueueOverrides = {
  batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 1 },
}

interface RequestSpec {
  text: string
  hash: string
  kind?: Kind
  providerRef?: ProviderRef
  sessionId?: string
  forceRetranslation?: boolean
  glossaryRevision?: number
}

interface Route {
  label: "page" | "subtitles"
  /** Only the page handler gives its requests a cancellation scope. */
  scoped: boolean
  start: (overrides?: QueueOverrides) => Promise<void>
  handler: () => Handler
  routeFields: (spec: RequestSpec) => Record<string, unknown>
}

function getHandler(name: string): Handler {
  const handler = mocks.handlers.get(name)
  if (!handler) throw new Error(`Missing handler: ${name}`)
  return handler as Handler
}

const ROUTES: Route[] = [
  {
    label: "page",
    scoped: true,
    start: async (overrides) => {
      mocks.ensureInitializedConfig.mockResolvedValue(queueConfig(overrides))
      const { setupPageTranslationHandlers } = await import("../page-translation")
      setupPageTranslationHandlers()
    },
    handler: () => getHandler("enqueueTranslateRequest"),
    routeFields: (spec) => ({
      sessionId: spec.sessionId,
      forceRetranslation: spec.forceRetranslation ?? false,
    }),
  },
  {
    label: "subtitles",
    scoped: false,
    start: async (overrides) => {
      mocks.ensureInitializedConfig.mockResolvedValue(queueConfig(overrides))
      const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
      setupSubtitlesTranslationHandlers()
    },
    handler: () => getHandler("enqueueSubtitlesTranslateRequest"),
    routeFields: () => ({}),
  },
]

/** Post one request exactly as the content script would. The promise never goes unhandled. */
function send(route: Route, spec: RequestSpec): Promise<string> {
  const result = route.handler()({
    data: {
      text: spec.text,
      langConfig: DEFAULT_CONFIG.language,
      providerRef: spec.providerRef ?? llmRef,
      hash: spec.hash,
      scheduleAt: Date.now(),
      glossaryTerms: [],
      glossaryRevision: spec.glossaryRevision ?? 0,
      ...(spec.kind === "snapshot" ? { promptTemplate: SNAPSHOT_TEMPLATE } : {}),
      ...route.routeFields(spec),
    },
    sender: { tab: { id: 39 } },
  })
  result.catch(() => {})
  return result
}

/** Let in-flight handlers run up to their next timer without flushing the 100 ms batch window. */
async function settle() {
  for (let turn = 0; turn < 8; turn++) await vi.advanceTimersByTimeAsync(0)
}

/** Move past BatchQueue's 100 ms window so pending batches flush into the RequestQueue. */
async function flushBatchWindow() {
  await vi.advanceTimersByTimeAsync(100)
  await settle()
}

function holdCall(key: string) {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  mocks.holds.set(key, { promise, open })
  return open
}

/** Hold the LLM provider call for exactly these batch segments until the returned release runs. */
function holdProvider(marker: Marker, segments: string[]) {
  return holdCall(`${marker}:${segments.join("|")}`)
}

function holdApi(text: string) {
  return holdCall(`api:${text}`)
}

function markerOf(options: GenerateOptions): Marker {
  if (options.instructions.includes("MARK-SNAP")) return "s"
  if (options.instructions.includes("MARK-LEGACY")) return "l"
  throw new Error("The provider ran a prompt that is neither the snapshot nor the stored one")
}

/** Every LLM provider call so far, as `marker:segment|segment`. */
function llmCalls() {
  return mocks.generateText.mock.calls.map(
    ([options]) => `${markerOf(options)}:${options.prompt.split(JOINED).join("|")}`,
  )
}

function llmCallShapes() {
  return mocks.generateText.mock.calls.map(([options]) => ({
    call: `${markerOf(options)}:${options.prompt.split(JOINED).join("|")}`,
    isBatch: options.instructions.includes(DEFAULT_BATCH_TRANSLATE_PROMPT),
  }))
}

/** The `hash` argument of every RequestQueue.enqueue call, in call order. */
async function spyRequestQueueKeys() {
  const { RequestQueue } = await import("@/utils/request/request-queue")
  const spy = vi.spyOn(RequestQueue.prototype, "enqueue")
  return () => spy.mock.calls.map((call) => call[2])
}

/** Persistent-cache traffic is confined to `allowed`; an empty hash must add nothing to it. */
function expectCacheTrafficOnly(allowed: string[]) {
  expect(mocks.cacheReads.filter((key) => !allowed.includes(key))).toEqual([])
  expect(
    mocks.cacheWrites.map((write) => write.key).filter((key) => !allowed.includes(key)),
  ).toEqual([])
}

const ORDERS: { name: string; first: Kind; second: Kind }[] = [
  { name: "snapshot X then legacy Y", first: "snapshot", second: "legacy" },
  { name: "legacy X then snapshot Y", first: "legacy", second: "snapshot" },
]

const COMBINATIONS: [Kind, Kind][] = [
  ["snapshot", "snapshot"],
  ["legacy", "legacy"],
  ["snapshot", "legacy"],
  ["legacy", "snapshot"],
]

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.cache.clear()
  mocks.cacheReads.length = 0
  mocks.cacheWrites.length = 0
  mocks.holds.clear()
  mocks.failOnce.clear()
  mocks.apiCalls.length = 0
  mocks.mismatchBatchCalls.value = false
  vi.useFakeTimers()
  mocks.ensureInitializedConfig.mockResolvedValue(queueConfig())
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  mocks.generateText.mockImplementation(async (options) => {
    const marker = markerOf(options)
    const segments = options.prompt.split(JOINED)
    const key = `${marker}:${segments.join("|")}`
    if (mocks.failOnce.delete(key)) throw new Error("transient provider failure")
    const hold = mocks.holds.get(key)
    if (hold) {
      mocks.holds.delete(key)
      await hold.promise
    }
    const translated = segments.map((text) => `${marker}:${text}`)
    // A provider that answers a batch with the wrong number of segments, to drive
    // BatchQueue into its per-item fallback. Individual calls carry no batch rules.
    if (
      mocks.mismatchBatchCalls.value &&
      options.instructions.includes(DEFAULT_BATCH_TRANSLATE_PROMPT)
    ) {
      translated.push(`${marker}:surplus`)
    }
    return { text: translated.join(JOINED) }
  })
  // Only the two synthetic DeepL/DeepLX hosts answer; everything else is refused.
  mocks.fetch.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const isDeepL = url === "https://api-free.deepl.com/v2/translate"
    if (!isDeepL && !url.startsWith("https://deeplx.example.test/")) {
      throw new Error("Live transport forbidden")
    }
    if (typeof init?.body !== "string") throw new Error("Unexpected request body")
    const body = JSON.parse(init.body) as { text: string | string[] }
    const text = Array.isArray(body.text) ? body.text[0]! : body.text
    mocks.apiCalls.push(text)
    const key = `api:${text}`
    if (mocks.failOnce.delete(key)) throw new Error("transient provider failure")
    const hold = mocks.holds.get(key)
    if (hold) {
      mocks.holds.delete(key)
      await hold.promise
    }
    const translated = `api:${text}`
    return new Response(
      JSON.stringify(
        isDeepL ? { translations: [{ text: translated }] } : { code: 200, data: translated },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
  vi.stubGlobal("fetch", mocks.fetch)
  // The stored selection is what a legacy request runs. The queue values stay valid here;
  // the queues themselves are built from the `ensureInitializedConfig` mock above.
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, queueConfig())
  const stored = await getLocalConfig()
  if (
    stored?.pageTranslation.customPromptsConfig.promptId !== STORED_PROMPT.id ||
    stored.videoSubtitles.customPromptsConfig.promptId !== STORED_PROMPT.id
  ) {
    throw new Error("The stored prompt fixture did not survive the config schema")
  }
})

afterEach(() => {
  for (const hold of mocks.holds.values()) hold.open()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(ROUTES)(
  "$label route: LLM batches of different texts with an empty hash",
  (route) => {
    it.each(ORDERS)(
      "$name: the second request arrives while the first batch is EXECUTING",
      async ({ first, second }) => {
        await route.start()
        const release = holdProvider(MARKER[first], [X])
        const a = send(route, { text: X, hash: "", kind: first })
        await settle()
        await flushBatchWindow()
        // Precondition: the first batch left BatchQueue and its provider call is in flight.
        expect(llmCalls()).toEqual([`${MARKER[first]}:${X}`])

        const b = send(route, { text: Y, hash: "", kind: second })
        await settle()
        await flushBatchWindow()
        release()
        await settle()

        expect(await Promise.all([a, b])).toEqual([
          `${MARKER[first]}:${X}`,
          `${MARKER[second]}:${Y}`,
        ])
        expect(llmCalls()).toEqual([`${MARKER[first]}:${X}`, `${MARKER[second]}:${Y}`])
        expectCacheTrafficOnly([])
        expect(mocks.cacheWrites).toEqual([])
      },
    )

    it.each(ORDERS)(
      "$name: the second request arrives while the first batch is WAITING for the rate limiter",
      async ({ first, second }) => {
        await route.start(ONE_TOKEN)
        // The blocker (its own batch key, because of the glossary revision) takes the only token.
        const blocker = send(route, {
          text: BLOCK,
          hash: BLOCK_HASH,
          kind: "snapshot",
          glossaryRevision: 7,
        })
        await settle()
        const a = send(route, { text: X, hash: "", kind: first })
        await settle()
        const b = send(route, { text: Y, hash: "", kind: second })
        await settle()
        await flushBatchWindow()
        // Precondition: only the blocker reached the provider; X's batch waits for a token.
        expect(llmCalls()).toEqual([`s:${BLOCK}`])

        await vi.advanceTimersByTimeAsync(5_000)

        expect(await Promise.all([blocker, a, b])).toEqual([
          `s:${BLOCK}`,
          `${MARKER[first]}:${X}`,
          `${MARKER[second]}:${Y}`,
        ])
        expect(llmCalls()).toEqual([
          `s:${BLOCK}`,
          `${MARKER[first]}:${X}`,
          `${MARKER[second]}:${Y}`,
        ])
        expectCacheTrafficOnly([BLOCK_HASH])
      },
    )

    it.each(COMBINATIONS)(
      "maxItemsPerBatch 1, %s X then %s Y: two one-item batches, each executed",
      async (first, second) => {
        await route.start(ONE_ITEM_BATCHES)
        const release = holdProvider(MARKER[first], [X])
        const a = send(route, { text: X, hash: "", kind: first })
        await settle()
        // Precondition: a one-item batch is size-full, so X is already at the provider.
        expect(llmCalls()).toEqual([`${MARKER[first]}:${X}`])

        const b = send(route, { text: Y, hash: "", kind: second })
        await settle()
        release()
        await settle()

        expect(await Promise.all([a, b])).toEqual([
          `${MARKER[first]}:${X}`,
          `${MARKER[second]}:${Y}`,
        ])
        expect(llmCallShapes()).toEqual([
          { call: `${MARKER[first]}:${X}`, isBatch: true },
          { call: `${MARKER[second]}:${Y}`, isBatch: true },
        ])
        expectCacheTrafficOnly([])
      },
    )

    it.each(["snapshot", "legacy"] as const)(
      "%s: a batch-count mismatch falls back to one provider call per item, each with its own result",
      async (kind) => {
        await route.start()
        mocks.mismatchBatchCalls.value = true
        const a = send(route, { text: X, hash: "", kind })
        const b = send(route, { text: Y, hash: "", kind })
        await settle()
        // 100 ms window, then three backoffs (1 s, 2 s, 4 s) before the per-item fallback.
        await vi.advanceTimersByTimeAsync(10_000)

        expect(await Promise.all([a, b])).toEqual([`${MARKER[kind]}:${X}`, `${MARKER[kind]}:${Y}`])
        const shapes = llmCallShapes()
        // Precondition: the batch path really failed, three retries included.
        expect(shapes.filter((shape) => shape.isBatch)).toHaveLength(4)
        expect(shapes.filter((shape) => !shape.isBatch).map((shape) => shape.call)).toEqual([
          `${MARKER[kind]}:${X}`,
          `${MARKER[kind]}:${Y}`,
        ])
        expectCacheTrafficOnly([])
      },
    )
  },
)

describe.each(ROUTES)("$label route: pure-API requests with an empty hash", (route) => {
  describe.each(PURE_API)("$label", ({ ref }) => {
    it("the second request arrives while the first is EXECUTING", async () => {
      await route.start()
      const release = holdApi(X)
      const a = send(route, { text: X, hash: "", providerRef: ref })
      await settle()
      expect(mocks.apiCalls).toEqual([X])

      const b = send(route, { text: Y, hash: "", providerRef: ref })
      await settle()
      release()
      await settle()

      expect(await Promise.all([a, b])).toEqual([`api:${X}`, `api:${Y}`])
      expect(mocks.apiCalls).toEqual([X, Y])
      expectCacheTrafficOnly([])
    })

    it("the second request arrives while the first is WAITING for the rate limiter", async () => {
      await route.start(ONE_TOKEN)
      const blocker = send(route, { text: BLOCK, hash: BLOCK_HASH, providerRef: ref })
      await settle()
      const a = send(route, { text: X, hash: "", providerRef: ref })
      await settle()
      // Precondition: the blocker holds the only token, so X is parked in the RequestQueue.
      expect(mocks.apiCalls).toEqual([BLOCK])
      const b = send(route, { text: Y, hash: "", providerRef: ref })
      await settle()

      await vi.advanceTimersByTimeAsync(5_000)

      expect(await Promise.all([blocker, a, b])).toEqual([`api:${BLOCK}`, `api:${X}`, `api:${Y}`])
      expect(mocks.apiCalls).toEqual([BLOCK, X, Y])
      expectCacheTrafficOnly([BLOCK_HASH])
    })
  })
})

describe.each(ROUTES)("$label route: queue identity across retries", (route) => {
  it("a RequestQueue retry of X is not joined by a later, different empty-hash request", async () => {
    await route.start()
    mocks.failOnce.add(`s:${X}`)
    const a = send(route, { text: X, hash: "", kind: "snapshot" })
    await settle()
    await flushBatchWindow()
    // Precondition: X's first attempt failed and its retry now waits one second in the queue.
    expect(llmCalls()).toEqual([`s:${X}`])

    const b = send(route, { text: Y, hash: "", kind: "legacy" })
    await settle()
    await flushBatchWindow()
    expect(llmCalls()).toEqual([`s:${X}`, `l:${Y}`])

    await vi.advanceTimersByTimeAsync(5_000)

    expect(await Promise.all([a, b])).toEqual([`s:${X}`, `l:${Y}`])
    // The failed attempt, Y once, and exactly one retry of X: no extra concurrent duplicate.
    expect(llmCalls()).toEqual([`s:${X}`, `l:${Y}`, `s:${X}`])
    expectCacheTrafficOnly([])
  })

  it("a count-mismatch retry reuses one queue identity and the fallback gives each item its own", async () => {
    const keys = await spyRequestQueueKeys()
    await route.start()
    mocks.mismatchBatchCalls.value = true
    const a = send(route, { text: X, hash: "", kind: "snapshot" })
    const b = send(route, { text: Y, hash: "", kind: "snapshot" })
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([a, b])

    const all = keys()
    // Four batch attempts (the first plus three retries), then one task per item.
    expect(all).toHaveLength(6)
    expect(new Set(all.slice(0, 4)).size).toBe(1)
    const [itemX, itemY] = all.slice(4)
    expect(itemX).not.toBe(itemY)
    for (const key of all) {
      expect(key).not.toBe("")
      expect(key).not.toContain(X)
      expect(key).not.toContain(Y)
    }
  })
})

describe.each(ROUTES.filter((route) => route.scoped))(
  "$label route: cancelling one empty-hash request",
  (route) => {
    const cancel = (sessionId: string) =>
      getHandler("cancelPageTranslationRequests")({
        data: { sessionId },
        sender: { tab: { id: 39 } },
      })

    it("does not cancel a different empty-hash request that is EXECUTING", async () => {
      await route.start()
      const releaseX = holdProvider("s", [X])
      const releaseY = holdProvider("l", [Y])
      const a = send(route, { text: X, hash: "", kind: "snapshot", sessionId: "one" })
      const b = send(route, { text: Y, hash: "", kind: "legacy", sessionId: "two" })
      await settle()
      await flushBatchWindow()
      // Precondition: both batches are at the provider at once.
      expect(llmCalls()).toEqual([`s:${X}`, `l:${Y}`])

      await cancel("one")
      releaseX()
      releaseY()
      await settle()

      const [cancelled, kept] = await Promise.allSettled([a, b])
      expect(cancelled).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ name: "TranslationCancelledError" }),
      })
      expect(kept).toEqual({ status: "fulfilled", value: `l:${Y}` })
    })

    it("does not cancel a different empty-hash request that is WAITING for the rate limiter", async () => {
      await route.start(ONE_TOKEN)
      const blocker = send(route, {
        text: BLOCK,
        hash: BLOCK_HASH,
        kind: "snapshot",
        glossaryRevision: 7,
      })
      await settle()
      const a = send(route, { text: X, hash: "", kind: "snapshot", sessionId: "one" })
      await settle()
      const b = send(route, { text: Y, hash: "", kind: "legacy", sessionId: "two" })
      await settle()
      await flushBatchWindow()
      expect(llmCalls()).toEqual([`s:${BLOCK}`])

      await cancel("one")
      await vi.advanceTimersByTimeAsync(5_000)

      const [cancelled, kept] = await Promise.allSettled([a, b])
      expect(cancelled).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ name: "TranslationCancelledError" }),
      })
      expect(kept).toEqual({ status: "fulfilled", value: `l:${Y}` })
      expect(await blocker).toBe(`s:${BLOCK}`)
      expect(llmCalls()).toEqual([`s:${BLOCK}`, `l:${Y}`])
    })
  },
)

describe.each(ROUTES)("$label route: queue keys that carry an empty-hash request", (route) => {
  it("pure-API requests get distinct, non-empty keys that carry none of the request", async () => {
    const keys = await spyRequestQueueKeys()
    await route.start()
    const pure = PURE_API[0]!.ref
    await Promise.all([
      send(route, { text: X, hash: "", providerRef: pure }),
      send(route, { text: Y, hash: "", providerRef: pure }),
    ])

    const [keyX, keyY] = keys()
    expect(keys()).toHaveLength(2)
    expect(keyX).not.toBe("")
    expect(keyY).not.toBe("")
    expect(keyX).not.toBe(keyY)
    for (const key of [keyX, keyY]) {
      expect(key).not.toContain(X)
      expect(key).not.toContain(Y)
      expect(key).not.toContain("deeplx")
    }
  })
})

describe.each(ROUTES)("$label route: invariants that must not move", (route) => {
  it("invariant: two identical requests with one non-empty hash still make one provider call (BatchQueue dedup)", async () => {
    await route.start()
    const a = send(route, { text: X, hash: "same-hash", kind: "snapshot" })
    const b = send(route, { text: X, hash: "same-hash", kind: "snapshot" })
    await settle()
    await flushBatchWindow()

    expect(await Promise.all([a, b])).toEqual([`s:${X}`, `s:${X}`])
    expect(llmCalls()).toEqual([`s:${X}`])
  })

  it("invariant: a later request with the same non-empty hash is still folded into the executing batch (RequestQueue dedup)", async () => {
    await route.start()
    const release = holdProvider("s", [X])
    const a = send(route, { text: X, hash: "same-hash", kind: "snapshot" })
    await settle()
    await flushBatchWindow()
    expect(llmCalls()).toEqual([`s:${X}`])

    const b = send(route, { text: X, hash: "same-hash", kind: "snapshot" })
    await settle()
    await flushBatchWindow()
    release()
    await settle()

    expect(await Promise.all([a, b])).toEqual([`s:${X}`, `s:${X}`])
    expect(llmCalls()).toEqual([`s:${X}`])
  })

  it("invariant: two pure-API requests with one non-empty hash still make one provider call", async () => {
    await route.start()
    const ref = PURE_API[0]!.ref
    const release = holdApi(X)
    const a = send(route, { text: X, hash: "same-hash", providerRef: ref })
    await settle()
    const b = send(route, { text: X, hash: "same-hash", providerRef: ref })
    await settle()
    release()
    await settle()

    expect(await Promise.all([a, b])).toEqual([`api:${X}`, `api:${X}`])
    expect(mocks.apiCalls).toEqual([X])
  })

  it("invariant: a non-empty hash is read from, and written to, the cache under that hash", async () => {
    await route.start()
    const fresh = send(route, { text: X, hash: "fresh-hash", kind: "snapshot" })
    await settle()
    await flushBatchWindow()
    expect(await fresh).toBe(`s:${X}`)
    expect(mocks.cacheReads).toEqual(["fresh-hash"])
    expect(mocks.cacheWrites).toEqual([{ key: "fresh-hash", translation: `s:${X}` }])

    const again = send(route, { text: X, hash: "fresh-hash", kind: "snapshot" })
    await settle()
    expect(await again).toBe(`s:${X}`)
    expect(llmCalls()).toEqual([`s:${X}`])
  })

  it.runIf(route.scoped)(
    "invariant: forceRetranslation skips the cache read and replaces the row",
    async () => {
      await route.start()
      mocks.cache.set("forced-hash", {
        key: "forced-hash",
        translation: "stale",
        createdAt: new Date(0),
      })
      const forced = send(route, {
        text: X,
        hash: "forced-hash",
        kind: "snapshot",
        forceRetranslation: true,
      })
      await settle()
      await flushBatchWindow()

      expect(await forced).toBe(`s:${X}`)
      expect(mocks.cacheReads).toEqual([])
      expect(mocks.cacheWrites).toEqual([{ key: "forced-hash", translation: `s:${X}` }])
    },
  )

  it.each([
    { label: "snapshot LLM", spec: { kind: "snapshot" as const }, expected: `s:${X}` },
    { label: "legacy LLM", spec: { kind: "legacy" as const }, expected: `l:${X}` },
    { label: "DeepLX", spec: { providerRef: PURE_API[0]!.ref }, expected: `api:${X}` },
    { label: "DeepL", spec: { providerRef: PURE_API[1]!.ref }, expected: `api:${X}` },
  ])(
    "invariant: a $label request with an empty hash never reads or writes the cache",
    async ({ spec, expected }) => {
      await route.start()
      // A row under the empty key must never be served, and nothing may be stored under it.
      mocks.cache.set("", { key: "", translation: "poisoned", createdAt: new Date() })
      const result = send(route, { text: X, hash: "", ...spec })
      await settle()
      await flushBatchWindow()

      expect(await result).toBe(expected)
      expect(mocks.cacheReads).toEqual([])
      expect(mocks.cacheWrites).toEqual([])
    },
  )
})
