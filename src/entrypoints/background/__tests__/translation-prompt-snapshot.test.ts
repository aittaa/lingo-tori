import type { LangCodeISO6393 } from "@/lib/languages"
import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { LANG_CODE_TO_EN_NAME } from "@/lib/languages"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { Sha256Hex } from "@/utils/hash"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"

type Marker = "a" | "b"

interface GenerateOptions {
  instructions: string
  prompt: string
}

interface WireMessage {
  name: string
  data: Record<string, unknown> & { hash: string }
}

type Handler = (message: {
  data: Record<string, unknown>
  sender?: { tab: { id: number } }
}) => Promise<string>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => Promise<any>>(),
  sent: [] as { name: string; data: any }[],
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  cacheGet: vi.fn<(...args: any[]) => any>(),
  cachePut: vi.fn<(...args: any[]) => any>(),
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
  generateText: vi.fn<(options: GenerateOptions) => Promise<{ text: string }>>(),
  createOpenAICompatible: vi.fn<(settings: Record<string, unknown>) => unknown>((settings) => ({
    languageModel: (modelId: string) => ({ ...settings, modelId }),
  })),
}))

// Everything that decides WHICH prompt runs stays real: the content-side hash
// (translateTextCore / translateSubtitles), the message payload, the production
// handlers, BatchQueue, RequestQueue, executeTranslate, aiTranslate and the
// prompt builders, reading a config that lives in WXT's fake storage. Only the
// message transport, the cache DB and the SDK are replaced, so no live call is
// possible. `sendMessage` hands each payload to the registered handler as a
// structured clone, which is what the extension message bus would deliver.
vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) => {
    mocks.handlers.set(name, handler)
  },
  sendMessage: async (name: string, data: unknown) => {
    const handler = mocks.handlers.get(name)
    if (!handler) throw new Error(`No handler registered for ${name}`)
    mocks.sent.push({ name, data: structuredClone(data) })
    return handler({ data: structuredClone(data), sender: { tab: { id: 39 } } })
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
  db: { translationCache: { get: mocks.cacheGet, put: mocks.cachePut } },
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

// The templates differ in a visible marker. `{{input}}` alone is the user
// prompt, so the text the SDK receives is exactly the batch text.
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

const provider: LLMProviderConfig = {
  id: "prompt-snapshot-provider",
  name: "Prompt snapshot provider",
  provider: "openai-compatible",
  enabled: true,
  baseURL: "https://prompt-snapshot.example/v1",
  apiKey: "synthetic-key",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "snapshot-model" },
}

function configSelecting(marker: Marker) {
  const queues = {
    providerId: provider.id,
    requestQueueConfig: { rate: 10, capacity: 10 },
    batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
  }
  const customPromptsConfig = {
    promptId: TEMPLATES[marker].id,
    patterns: [TEMPLATES.a, TEMPLATES.b],
  }
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [provider],
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, ...queues, customPromptsConfig },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, ...queues, customPromptsConfig },
  }
}

/** The user switching the selected prompt in settings. */
async function selectPrompt(marker: Marker) {
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, configSelecting(marker))
}

function executedBatches() {
  return mocks.generateText.mock.calls.map(([options]) => ({
    marker: /MARK-([AB])/.exec(options.instructions)?.[1]?.toLowerCase() ?? "none",
    segments: options.prompt.split(JOINED),
    instructions: options.instructions,
  }))
}

function enqueueMessages(name: string): WireMessage[] {
  return mocks.sent.filter((message) => message.name === name)
}

const DEFAULT_TARGET = DEFAULT_CONFIG.language.targetCode

interface Route {
  label: string
  enqueueName: "enqueueTranslateRequest" | "enqueueSubtitlesTranslateRequest"
  /** Run the production content-side entry point; resolves with the translation. */
  start: () => Promise<(text: string, targetCode?: LangCodeISO6393) => Promise<string>>
  /** The cache key the content side must derive from the prompt selected right now. */
  expectedHash: (text: string) => Promise<string>
  /** A hand-built message, as a sender would post it. */
  message: (fields: {
    text: string
    hash: string
    targetCode?: LangCodeISO6393
    sessionId?: string
    promptTemplate?: { systemPrompt: string; prompt: string }
  }) => { data: Record<string, unknown>; sender: { tab: { id: number } } }
  handler: () => Handler
}

function getHandler(name: string): Handler {
  const handler = mocks.handlers.get(name)
  if (!handler) throw new Error(`Missing handler: ${name}`)
  return handler as Handler
}

const providerRef = { kind: "local" as const, config: provider }

const ROUTES: Route[] = [
  {
    label: "page",
    enqueueName: "enqueueTranslateRequest",
    start: async () => {
      const { setupPageTranslationHandlers } = await import("../page-translation")
      setupPageTranslationHandlers()
      const { translateTextCore } = await import("@/utils/host/translate/translate-text")
      return (text, targetCode = DEFAULT_TARGET) =>
        translateTextCore({
          text,
          langConfig: { ...DEFAULT_CONFIG.language, targetCode },
          providerConfig: { ...providerRef, id: provider.id, name: provider.name },
        })
    },
    expectedHash: async (text) => {
      const preparedText = prepareTranslationText(text)
      const { systemPrompt, prompt } = await getTranslatePrompt(
        LANG_CODE_TO_EN_NAME[DEFAULT_TARGET],
        preparedText,
        { isBatch: true, context: undefined, glossaryTerms: [] },
      )
      return Sha256Hex(
        preparedText,
        JSON.stringify(provider),
        DEFAULT_CONFIG.language.sourceCode,
        DEFAULT_TARGET,
        systemPrompt,
        prompt,
        "enableAIContentAware=false",
      )
    },
    message: ({ text, hash, targetCode = DEFAULT_TARGET, sessionId, promptTemplate }) => ({
      data: {
        text,
        langConfig: { ...DEFAULT_CONFIG.language, targetCode },
        providerRef,
        hash,
        scheduleAt: Date.now(),
        glossaryTerms: [],
        glossaryRevision: 0,
        sessionId,
        ...(promptTemplate ? { promptTemplate } : {}),
      },
      sender: { tab: { id: 39 } },
    }),
    handler: () => getHandler("enqueueTranslateRequest"),
  },
  {
    label: "subtitles",
    enqueueName: "enqueueSubtitlesTranslateRequest",
    start: async () => {
      const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
      setupSubtitlesTranslationHandlers()
      const { translateSubtitles } = await import("@/utils/subtitles/processor/translator")
      return async (text, targetCode) => {
        const [fragment] = await translateSubtitles(
          [{ text, start: 0, end: 1_000 }],
          { videoTitle: "", videoDescription: "", subtitlesTextContent: "" },
          undefined,
          targetCode,
        )
        return fragment?.translation ?? ""
      }
    },
    expectedHash: async (text) => {
      const preparedText = prepareTranslationText(text)
      const { systemPrompt, prompt } = await getSubtitlesTranslatePrompt(
        LANG_CODE_TO_EN_NAME[DEFAULT_TARGET],
        preparedText,
        {
          isBatch: true,
          context: { webTitle: null, webDescription: null, videoSummary: undefined },
          glossaryTerms: [],
        },
      )
      // The subtitle route resolves its provider from the schema-parsed config,
      // which can add defaults to the raw fixture; the cache identity is that one.
      const effective = (await getLocalConfig())?.providersConfig.find(
        (candidate) => candidate.id === provider.id,
      )
      return Sha256Hex(
        preparedText,
        getProviderCacheIdentity({ kind: "local", config: effective! }),
        DEFAULT_CONFIG.language.sourceCode,
        DEFAULT_TARGET,
        systemPrompt,
        prompt,
        "enableAIContentAware=false",
      )
    },
    message: ({ text, hash, targetCode = DEFAULT_TARGET, promptTemplate }) => ({
      data: {
        text,
        langConfig: { ...DEFAULT_CONFIG.language, targetCode },
        providerRef,
        hash,
        scheduleAt: Date.now(),
        glossaryTerms: [],
        glossaryRevision: 0,
        ...(promptTemplate ? { promptTemplate } : {}),
      },
      sender: { tab: { id: 39 } },
    }),
    handler: () => getHandler("enqueueSubtitlesTranslateRequest"),
  },
]

/** Let the content side reach `sendMessage` without flushing the 100 ms batch window. */
async function untilEnqueued(route: Route, count: number) {
  for (let turn = 0; turn < 100; turn++) {
    if (enqueueMessages(route.enqueueName).length >= count) return
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error(`Content side never enqueued request ${count}`)
}

/** One content-side request made under the prompt selected at this moment. */
async function submit(
  route: Route,
  translate: Awaited<ReturnType<Route["start"]>>,
  marker: Marker,
  text: string,
  targetCode?: LangCodeISO6393,
) {
  await selectPrompt(marker)
  const expectedHash = await route.expectedHash(text)
  const before = enqueueMessages(route.enqueueName).length
  const result = translate(text, targetCode)
  // Handlers can reject (cancellation); the test that awaits `result` sees it.
  result.catch(() => {})
  await untilEnqueued(route, before + 1)
  return { result, expectedHash, payload: enqueueMessages(route.enqueueName)[before]!.data }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.sent.length = 0
  vi.useFakeTimers()
  mocks.ensureInitializedConfig.mockResolvedValue(configSelecting("a"))
  mocks.cacheGet.mockResolvedValue(undefined)
  mocks.cachePut.mockResolvedValue(undefined)
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  mocks.generateText.mockImplementation(async ({ instructions, prompt }) => {
    const marker = /MARK-([AB])/.exec(instructions)?.[1]?.toLowerCase() ?? "none"
    return {
      text: prompt
        .split(JOINED)
        .map((text) => `${marker}:${text}`)
        .join(JOINED),
    }
  })
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Live transport forbidden")),
  )
  await selectPrompt("a")
  // The fixtures must survive the config schema, or every builder would quietly
  // fall back to the product default and no marker would ever appear.
  const stored = await getLocalConfig()
  if (
    stored?.pageTranslation.customPromptsConfig.promptId !== "prompt-a" ||
    stored.videoSubtitles.customPromptsConfig.promptId !== "prompt-a"
  ) {
    throw new Error("The prompt fixtures did not survive the config schema")
  }
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(ROUTES)("$label prompt snapshot", (route) => {
  it("keeps the cache key byte-identical to the prompt the content side selected", async () => {
    const translate = await route.start()

    const a = await submit(route, translate, "a", "para-1")
    await vi.advanceTimersByTimeAsync(100)
    await a.result
    const b = await submit(route, translate, "b", "para-2")
    await vi.advanceTimersByTimeAsync(100)
    await b.result

    expect(a.payload.hash).toBe(a.expectedHash)
    expect(b.payload.hash).toBe(b.expectedHash)
    expect(a.payload.hash).not.toBe(b.payload.hash)
  })

  it("sends the raw, unsubstituted selected template with the request", async () => {
    const translate = await route.start()

    const { result, payload } = await submit(route, translate, "a", "para-1")
    await vi.advanceTimersByTimeAsync(100)
    await result

    // Raw: the target language is still a token, so the background resolves it
    // from the request's own langConfig (#85) rather than from this snapshot.
    expect(payload.promptTemplate).toEqual({
      systemPrompt: TEMPLATES.a.systemPrompt,
      prompt: TEMPLATES.a.prompt,
    })
  })

  it("executes the prompt the hash was taken over when the selection changes before the flush", async () => {
    const translate = await route.start()

    const first = await submit(route, translate, "a", "para-1")
    // The request is waiting in the batch window when the user switches to B.
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)

    expect(await first.result).toBe("a:para-1")
    expect(executedBatches()).toEqual([
      expect.objectContaining({ marker: "a", segments: ["para-1"] }),
    ])
    expect(mocks.cachePut).toHaveBeenCalledTimes(1)
    expect(mocks.cachePut).toHaveBeenCalledWith(
      expect.objectContaining({ key: first.payload.hash, translation: "a:para-1" }),
    )
  })

  it("keeps A→B→A requests in prompt-pure batches, each cached under its own key", async () => {
    const translate = await route.start()

    const first = await submit(route, translate, "a", "para-1")
    const second = await submit(route, translate, "b", "para-2")
    const third = await submit(route, translate, "a", "para-3")
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all([first.result, second.result, third.result])).toEqual([
      "a:para-1",
      "b:para-2",
      "a:para-3",
    ])
    const batches = executedBatches().sort((x, y) => x.marker.localeCompare(y.marker))
    expect(batches).toEqual([
      expect.objectContaining({ marker: "a", segments: ["para-1", "para-3"] }),
      expect.objectContaining({ marker: "b", segments: ["para-2"] }),
    ])
    expect(mocks.cachePut).toHaveBeenCalledTimes(3)
    for (const [request, translation] of [
      [first, "a:para-1"],
      [second, "b:para-2"],
      [third, "a:para-3"],
    ] as const) {
      expect(mocks.cachePut).toHaveBeenCalledWith(
        expect.objectContaining({ key: request.payload.hash, translation }),
      )
    }
  })

  it("still batches requests that share a prompt template", async () => {
    const translate = await route.start()

    const first = await submit(route, translate, "a", "para-1")
    const second = await submit(route, translate, "a", "para-2")
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all([first.result, second.result])).toEqual(["a:para-1", "a:para-2"])
    expect(executedBatches()).toEqual([
      expect.objectContaining({ marker: "a", segments: ["para-1", "para-2"] }),
    ])
    expect(mocks.putBatchRequestRecord).toHaveBeenCalledWith(
      expect.objectContaining({ originalRequestCount: 2 }),
    )
  })

  it("batches an old sender's requests without a template and resolves the current prompt", async () => {
    await route.start()
    await selectPrompt("b")
    const handler = route.handler()

    const first = route.message({ text: "legacy-1", hash: "legacy-hash-1" })
    const second = route.message({ text: "legacy-2", hash: "legacy-hash-2" })
    const results = Promise.all([handler(first), handler(second)])
    await vi.advanceTimersByTimeAsync(100)

    expect(await results).toEqual(["b:legacy-1", "b:legacy-2"])
    expect(executedBatches()).toEqual([
      expect.objectContaining({ marker: "b", segments: ["legacy-1", "legacy-2"] }),
    ])
  })

  it("does not batch different target languages and names each language in its own prompt", async () => {
    const translate = await route.start()

    const japanese = await submit(route, translate, "a", "para-1", "jpn")
    const korean = await submit(route, translate, "a", "para-2", "kor")
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all([japanese.result, korean.result])).toEqual(["a:para-1", "a:para-2"])
    const batches = executedBatches()
    expect(batches).toHaveLength(2)
    expect(batches.find((batch) => batch.segments[0] === "para-1")?.instructions).toContain(
      "Japanese",
    )
    expect(batches.find((batch) => batch.segments[0] === "para-2")?.instructions).toContain(
      "Korean",
    )
  })
})

describe("page cancellation with prompt snapshots", () => {
  it("drains only the cancelled scope and leaves the other scope's template intact", async () => {
    const [page] = ROUTES
    await page!.start()
    await selectPrompt("a")
    const handler = page!.handler()
    const template = { systemPrompt: TEMPLATES.a.systemPrompt, prompt: TEMPLATES.a.prompt }

    const cancelled = handler(
      page!.message({
        text: "cancelled",
        hash: "h-old",
        sessionId: "old",
        promptTemplate: template,
      }),
    ).catch((error: unknown) => error)
    const active = handler(
      page!.message({ text: "active", hash: "h-new", sessionId: "new", promptTemplate: template }),
    )
    await vi.advanceTimersByTimeAsync(0)
    await getHandler("cancelPageTranslationRequests")({
      data: { sessionId: "old" },
      sender: { tab: { id: 39 } },
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(await cancelled).toMatchObject({ name: "TranslationCancelledError" })
    expect(await active).toBe("a:active")
    expect(executedBatches()).toEqual([
      expect.objectContaining({ marker: "a", segments: ["active"] }),
    ])
    expect(mocks.cachePut).toHaveBeenCalledTimes(1)
    expect(mocks.cachePut).toHaveBeenCalledWith(
      expect.objectContaining({ key: "h-new", translation: "a:active" }),
    )
  })
})
