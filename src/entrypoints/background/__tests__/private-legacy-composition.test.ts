// Integration test for the combination of PR94 (private-window senders) and PR95 (requests with no
// prompt snapshot). Neither branch's own tests know about the other, so nothing else covers a request
// that is both private and legacy. Real handlers, BatchQueue, RequestQueue and prompt builders; only
// the transport, the cache DB and the SDK are replaced.
import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { Sha256Hex } from "@/utils/hash"

type Marker = "a" | "b"
type SenderKind = "normal" | "private"
type PromptKind = "snapshot" | "legacy"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => Promise<any>>(),
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  cacheGet: vi.fn<(...args: any[]) => any>(),
  cachePut: vi.fn<(...args: any[]) => any>(),
  cacheDelete: vi.fn<(...args: any[]) => any>(),
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
  executeTranslate: vi.fn<(...args: any[]) => Promise<string>>(),
  generateText:
    vi.fn<(options: { instructions: string; prompt: string }) => Promise<{ text: string }>>(),
  createOpenAICompatible: vi.fn<(settings: Record<string, unknown>) => unknown>((settings) => ({
    languageModel: (modelId: string) => ({ ...settings, modelId }),
  })),
}))

vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) => {
    mocks.handlers.set(name, handler)
  },
  sendMessage: vi.fn<(...args: any[]) => any>(),
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
    translationCache: { get: mocks.cacheGet, put: mocks.cachePut, delete: mocks.cacheDelete },
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
const TEMPLATES: Record<
  Marker,
  { id: string; name: string; systemPrompt: string; prompt: string }
> = {
  a: {
    id: "prompt-a",
    name: "Prompt A",
    systemPrompt: "MARK-A: translate into {{targetLanguage}}.",
    prompt: "{{input}}",
  },
  b: {
    id: "prompt-b",
    name: "Prompt B",
    systemPrompt: "MARK-B: translate into {{targetLanguage}}.",
    prompt: "{{input}}",
  },
}

const llmProvider: LLMProviderConfig = {
  id: "integration-provider",
  name: "Integration provider",
  provider: "openai-compatible",
  enabled: true,
  baseURL: "http://127.0.0.1:1/v1",
  apiKey: "synthetic-key",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "integration-model" },
}
// Not an LLM provider, so the handlers take the per-request RequestQueue path.
const pureApiProvider = {
  id: "integration-pure-api",
  name: "Integration pure API provider",
  provider: "deeplx",
  enabled: true,
  baseURL: "http://127.0.0.1:1/translate",
} as never

function storedConfig(provider: { id: string }) {
  const queues = {
    providerId: provider.id,
    requestQueueConfig: { rate: 10, capacity: 10 },
    batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
  }
  // The stored selection stays "a" throughout. A snapshot request carries template "b" so the
  // output shows whether a request ran its own snapshot ("b") or resolved the stored one ("a").
  const customPromptsConfig = { promptId: TEMPLATES.a.id, patterns: [TEMPLATES.a, TEMPLATES.b] }
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [provider],
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, ...queues, customPromptsConfig },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, ...queues, customPromptsConfig },
  }
}

const ROUTES = [
  {
    label: "page",
    name: "enqueueTranslateRequest",
    start: async () => (await import("../page-translation")).setupPageTranslationHandlers(),
  },
  {
    label: "subtitles",
    name: "enqueueSubtitlesTranslateRequest",
    start: async () =>
      (await import("../subtitles-translation")).setupSubtitlesTranslationHandlers(),
  },
]

const COMBOS: Array<{ label: string; sender: SenderKind; prompt: PromptKind }> = [
  { label: "normal + snapshot", sender: "normal", prompt: "snapshot" },
  { label: "normal + legacy", sender: "normal", prompt: "legacy" },
  { label: "private + snapshot", sender: "private", prompt: "snapshot" },
  { label: "private + legacy", sender: "private", prompt: "legacy" },
]
type Combo = (typeof COMBOS)[number]

interface Req {
  text: string
  hash: string
  sender: SenderKind
  prompt: PromptKind
  tab?: number
  textFormat?: "html"
  provider?: unknown
}

function wire(req: Req) {
  const incognito = req.sender === "private"
  return {
    data: {
      text: req.text,
      langConfig: { ...DEFAULT_CONFIG.language },
      providerRef: { kind: "local" as const, config: req.provider ?? llmProvider },
      hash: req.hash,
      scheduleAt: Date.now(),
      glossaryTerms: [],
      glossaryRevision: 0,
      ...(req.textFormat && { textFormat: req.textFormat }),
      // A legacy request is one from an older content script: no prompt snapshot on the wire.
      ...(req.prompt === "snapshot" && {
        promptTemplate: {
          systemPrompt: TEMPLATES.b.systemPrompt,
          prompt: TEMPLATES.b.prompt,
        },
      }),
    },
    sender: { tab: { id: req.tab ?? (incognito ? 2 : 1), incognito } },
  }
}

/** What each provider call carried: `<prompt marker>|<sorted texts>`. */
const executed = () =>
  mocks.generateText.mock.calls
    .map(
      ([o]) =>
        `${/MARK-([AB])/.exec(o.instructions)?.[1]?.toLowerCase() ?? "none"}|${o.prompt.split(JOINED).sort().join(",")}`,
    )
    .sort()

const cacheGetKeys = () => mocks.cacheGet.mock.calls.map(([k]) => k as string).sort()
const cachePutKeys = () => mocks.cachePut.mock.calls.map(([e]) => e.key as string).sort()

async function run(route: (typeof ROUTES)[number], requests: Req[]) {
  await route.start()
  const handler = mocks.handlers.get(route.name)!
  const pending = requests.map((r) => handler(wire(r)))
  pending.forEach((p) => p.catch(() => {}))
  await vi.advanceTimersByTimeAsync(1000)
  return Promise.all(pending)
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  vi.useFakeTimers()
  mocks.ensureInitializedConfig.mockResolvedValue(storedConfig(llmProvider))
  mocks.cacheGet.mockResolvedValue(undefined)
  mocks.cachePut.mockResolvedValue(undefined)
  mocks.cacheDelete.mockResolvedValue(undefined)
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  mocks.generateText.mockImplementation(async ({ instructions, prompt }) => {
    const marker = /MARK-([AB])/.exec(instructions)?.[1]?.toLowerCase() ?? "none"
    return {
      text: prompt
        .split(JOINED)
        .map((t) => `${marker}:${t}`)
        .join(JOINED),
    }
  })
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Live transport forbidden")),
  )
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, storedConfig(llmProvider))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock("@/utils/host/translate/execute-translate")
})

describe.each(ROUTES)("$label: private x legacy composition (batch provider)", (route) => {
  describe("queue identity", () => {
    it("gives the four combinations four distinct identities; normal + snapshot keeps the raw hash", async () => {
      const { BatchQueue } = await import("@/utils/request/batch-queue")
      const enqueue = vi.spyOn(BatchQueue.prototype, "enqueue")
      const legacyTag = Sha256Hex("legacy-prompt-resolution", "h-same")

      await run(
        route,
        COMBOS.map((c) => ({ text: "same", hash: "h-same", sender: c.sender, prompt: c.prompt })),
      )

      const identities = enqueue.mock.calls.map(([data]) => ({
        hash: (data as { hash: string }).hash,
        privateSender: (data as { privateSender?: boolean }).privateSender,
        promptTemplate: (data as { promptTemplate?: unknown }).promptTemplate,
      }))
      expect(identities).toHaveLength(4)
      const byCombo = (c: Combo) =>
        identities.find(
          (i) =>
            Boolean(i.privateSender) === (c.sender === "private") &&
            (i.promptTemplate !== undefined) === (c.prompt === "snapshot"),
        )!.hash
      // snapshot-normal is byte-identical to the raw hash, as before either branch
      expect(byCombo(COMBOS[0]!)).toBe("h-same")
      expect(byCombo(COMBOS[1]!)).toBe(legacyTag)
      expect(byCombo(COMBOS[2]!)).toBe(Sha256Hex("private-sender", "h-same"))
      // a private legacy request carries BOTH separations: tag first, private namespace on top
      expect(byCombo(COMBOS[3]!)).toBe(Sha256Hex("private-sender", legacyTag))
      expect(new Set(identities.map((i) => i.hash)).size).toBe(4)
      expect(identities.filter((i) => i.privateSender).length).toBe(2)
    })

    it.each(COMBOS)(
      "$label: identical in-flight requests of one combination still dedup",
      async (combo) => {
        const results = await run(route, [
          { text: "same", hash: "h-same", sender: combo.sender, prompt: combo.prompt, tab: 3 },
          { text: "same", hash: "h-same", sender: combo.sender, prompt: combo.prompt, tab: 4 },
        ])

        const marker = combo.prompt === "snapshot" ? "b" : "a"
        expect(results).toEqual([`${marker}:same`, `${marker}:same`])
        expect(mocks.generateText).toHaveBeenCalledTimes(1)
      },
    )
  })

  describe("provider calls", () => {
    it("never merges identical text and hash across the four combinations; each runs its own prompt", async () => {
      const results = await run(
        route,
        COMBOS.map((c) => ({ text: "same", hash: "h-same", sender: c.sender, prompt: c.prompt })),
      )

      // snapshot requests run template B; legacy requests resolve the stored selection (A)
      expect(results).toEqual(["b:same", "a:same", "b:same", "a:same"])
      expect(mocks.generateText).toHaveBeenCalledTimes(4)
      expect(executed()).toEqual(["a|same", "a|same", "b|same", "b|same"])
    })

    it("still batches like with like: a mixed window splits into exactly one request per combination", async () => {
      const requests: Req[] = [
        { text: "ns-1", hash: "h-ns-1", sender: "normal", prompt: "snapshot" },
        { text: "nl-1", hash: "h-nl-1", sender: "normal", prompt: "legacy" },
        { text: "ps-1", hash: "h-ps-1", sender: "private", prompt: "snapshot" },
        { text: "pl-1", hash: "h-pl-1", sender: "private", prompt: "legacy" },
        { text: "ns-2", hash: "h-ns-2", sender: "normal", prompt: "snapshot" },
        { text: "nl-2", hash: "h-nl-2", sender: "normal", prompt: "legacy" },
        { text: "ps-2", hash: "h-ps-2", sender: "private", prompt: "snapshot" },
        { text: "pl-2", hash: "h-pl-2", sender: "private", prompt: "legacy" },
      ]

      const results = await run(route, requests)

      expect(results).toEqual(
        requests.map((r) => `${r.prompt === "snapshot" ? "b" : "a"}:${r.text}`),
      )
      expect(executed()).toEqual(["a|nl-1,nl-2", "a|pl-1,pl-2", "b|ns-1,ns-2", "b|ps-1,ps-2"])
    })
  })

  describe("persistent cache gates", () => {
    it.each([
      { combo: COMBOS[0]!, reads: ["h-x"], writes: ["h-x"] },
      { combo: COMBOS[1]!, reads: ["h-x"], writes: [] },
      { combo: COMBOS[2]!, reads: [], writes: [] },
      { combo: COMBOS[3]!, reads: [], writes: [] },
    ])("$combo.label: reads $reads, writes $writes", async ({ combo, reads, writes }) => {
      await run(route, [{ text: "x", hash: "h-x", sender: combo.sender, prompt: combo.prompt }])

      expect(cacheGetKeys()).toEqual(reads)
      expect(cachePutKeys()).toEqual(writes)
      expect(mocks.cacheDelete).not.toHaveBeenCalled()
    })

    it("an existing row is served to normal senders (snapshot and legacy) and never to private ones", async () => {
      mocks.cacheGet.mockResolvedValue({
        key: "h-x",
        translation: "PERSISTED",
        createdAt: new Date(),
      })

      const results = await run(
        route,
        COMBOS.map((c) => ({ text: "x", hash: "h-x", sender: c.sender, prompt: c.prompt })),
      )

      expect(results).toEqual(["PERSISTED", "PERSISTED", "b:x", "a:x"])
      // only the two private requests reached the provider, and neither wrote the row
      expect(executed()).toEqual(["a|x", "b|x"])
      expect(cacheGetKeys()).toEqual(["h-x", "h-x"])
      expect(cachePutKeys()).toEqual([])
      expect(mocks.cacheDelete).not.toHaveBeenCalled()
    })

    it("a cache write by the normal + snapshot request is the only write of a mixed window", async () => {
      await run(
        route,
        COMBOS.map((c) => ({ text: "same", hash: "h-same", sender: c.sender, prompt: c.prompt })),
      )

      expect(cachePutKeys()).toEqual(["h-same"])
      // ...and it holds the snapshot's own output, not the legacy run's
      expect(mocks.cachePut.mock.calls[0]?.[0].translation).toBe("b:same")
    })
  })
})

describe("page: invalid-marker cache delete gate", () => {
  const route = ROUTES[0]!
  const html = '<a data-rf-attr="1">link</a>'

  it.each(COMBOS)(
    "$label: deletes a stale marker-less row only when it may read the cache",
    async (combo) => {
      mocks.cacheGet.mockResolvedValue({
        key: "h-html",
        translation: "STALE-NO-MARKERS",
        createdAt: new Date(),
      })

      await run(route, [
        {
          text: html,
          hash: "h-html",
          sender: combo.sender,
          prompt: combo.prompt,
          textFormat: "html",
        },
      ])

      const mayRead = combo.sender === "normal"
      expect(mocks.cacheDelete.mock.calls.map(([k]) => k)).toEqual(mayRead ? ["h-html"] : [])
      expect(cacheGetKeys()).toEqual(mayRead ? ["h-html"] : [])
      expect(cachePutKeys()).toEqual(
        combo.sender === "normal" && combo.prompt === "snapshot" ? ["h-html"] : [],
      )
    },
  )
})

describe.each(ROUTES)("$label: promptless request on a pure-API (non-batch) provider", (route) => {
  beforeEach(() => {
    mocks.ensureInitializedConfig.mockResolvedValue(storedConfig(pureApiProvider))
    mocks.executeTranslate.mockImplementation(
      (text: string) => new Promise((resolve) => setTimeout(() => resolve(`api:${text}`), 50)),
    )
    vi.doMock("@/utils/host/translate/execute-translate", () => ({
      executeTranslate: mocks.executeTranslate,
    }))
  })

  it("is not 'legacy': a normal sender caches it, a private sender does not, and they never share a request", async () => {
    const results = await run(route, [
      {
        text: "same",
        hash: "h-api",
        sender: "normal",
        prompt: "legacy",
        provider: pureApiProvider,
      },
      {
        text: "same",
        hash: "h-api",
        sender: "private",
        prompt: "legacy",
        provider: pureApiProvider,
      },
    ])

    expect(results).toEqual(["api:same", "api:same"])
    expect(mocks.executeTranslate).toHaveBeenCalledTimes(2)
    expect(cacheGetKeys()).toEqual(["h-api"])
    expect(cachePutKeys()).toEqual(["h-api"])
  })

  it("two normal promptless requests still dedup into one provider call", async () => {
    const results = await run(route, [
      {
        text: "same",
        hash: "h-api",
        sender: "normal",
        prompt: "legacy",
        provider: pureApiProvider,
        tab: 5,
      },
      {
        text: "same",
        hash: "h-api",
        sender: "normal",
        prompt: "legacy",
        provider: pureApiProvider,
        tab: 6,
      },
    ])

    expect(results).toEqual(["api:same", "api:same"])
    expect(mocks.executeTranslate).toHaveBeenCalledTimes(1)
  })
})
