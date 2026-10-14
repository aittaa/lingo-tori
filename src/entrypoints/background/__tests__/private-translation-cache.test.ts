import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { Sha256Hex } from "@/utils/hash"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"

// Synthetic text only. Nothing here can reach a live provider: `generateText`,
// the SDK factory, the provider-ref text generator and the Dexie tables are
// all replaced, and `fetch` is stubbed to reject.

interface ModelSettings {
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

interface GenerateOptions {
  model: ModelSettings & { modelId: string }
  prompt: string
}

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn<(...args: any[]) => any>(),
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
  generateText: vi.fn<(options: GenerateOptions) => Promise<{ text: string }>>(),
  createOpenAICompatible: vi.fn<
    (settings: ModelSettings) => {
      languageModel: (modelId: string) => ModelSettings & { modelId: string }
    }
  >((settings) => ({
    languageModel: (modelId: string) => ({ ...settings, modelId }),
  })),
  promptResolver: vi.fn<
    (target: string, text: string) => Promise<{ systemPrompt: string; prompt: string }>
  >(async (_target, text) => ({
    systemPrompt: "Translate the captured text.",
    prompt: text,
  })),
  generateTextForProviderRef: vi.fn<(...args: any[]) => Promise<string>>(),
  executeTranslate: vi.fn<(...args: any[]) => Promise<string>>(),
  translationCache: {
    get: vi.fn<(...args: any[]) => any>(),
    put: vi.fn<(...args: any[]) => any>(),
    delete: vi.fn<(...args: any[]) => any>(),
  },
  articleSummaryCache: {
    get: vi.fn<(...args: any[]) => any>(),
    put: vi.fn<(...args: any[]) => any>(),
  },
  aiSegmentationCache: {
    get: vi.fn<(...args: any[]) => any>(),
    put: vi.fn<(...args: any[]) => any>(),
    delete: vi.fn<(...args: any[]) => any>(),
  },
}))

vi.mock("@/utils/message", () => ({ onMessage: mocks.onMessage }))
vi.mock("../config", () => ({ ensureInitializedConfig: mocks.ensureInitializedConfig }))
vi.mock("../background-stream", () => ({
  generateTextForProviderRef: mocks.generateTextForProviderRef,
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: mocks.putBatchRequestRecord,
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: mocks.translationCache,
    articleSummaryCache: mocks.articleSummaryCache,
    aiSegmentationCache: mocks.aiSegmentationCache,
  },
}))
vi.mock("@/utils/prompts/translate", () => ({ getTranslatePrompt: mocks.promptResolver }))
vi.mock("@/utils/prompts/subtitles", () => ({ getSubtitlesTranslatePrompt: mocks.promptResolver }))
vi.mock("@/utils/host/translate/translate-text", () => ({
  normalizePromptContextValue: (value?: string) => value ?? "",
}))
vi.mock("ai", () => ({ generateText: mocks.generateText }))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))

const JOINED = `\n\n${BATCH_SEPARATOR}\n\n`

type Sender = { tab?: { id?: number; incognito?: boolean } } | undefined

const PRIVATE_SENDER: Sender = { tab: { id: 7, incognito: true } }
const NORMAL_SENDER: Sender = { tab: { id: 8, incognito: false } }
// Every shape of sender that must keep today's persistent-cache behaviour.
const NON_PRIVATE_SENDERS: [string, Sender][] = [
  ["a normal tab", NORMAL_SENDER],
  ["a tab without the incognito field", { tab: { id: 9 } }],
  ["no sender at all", undefined],
]

function createProvider(): LLMProviderConfig {
  return {
    id: "synthetic-provider",
    name: "Synthetic provider",
    provider: "openai-compatible",
    enabled: true,
    baseURL: "https://synthetic.example/v1",
    apiKey: "synthetic-key",
    model: { model: "use-custom-model", isCustomModel: true, customModel: "model-a" },
  }
}

// Not an LLM provider, so the handlers take the per-request RequestQueue path
// instead of the BatchQueue. Its executor is replaced per test.
function createLocalProvider() {
  return {
    id: "synthetic-local",
    name: "Synthetic local provider",
    provider: "deeplx",
    enabled: true,
    baseURL: "https://synthetic-local.example/translate",
  } as never
}

function configFor(provider: LLMProviderConfig) {
  const queues = {
    providerId: provider.id,
    requestQueueConfig: { rate: 10, capacity: 10 },
    batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
  }
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [provider],
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, ...queues },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, ...queues },
  }
}

type Handler = (message: { data: Record<string, unknown>; sender?: Sender }) => Promise<unknown>

function getHandler(name: string): Handler {
  const handler = mocks.onMessage.mock.calls.find(([registered]) => registered === name)?.[1]
  if (typeof handler !== "function") throw new Error(`Missing handler: ${name}`)
  return handler as Handler
}

async function startHandler(route: "page" | "subtitles") {
  if (route === "page") {
    const { setupPageTranslationHandlers } = await import("../page-translation")
    setupPageTranslationHandlers()
    return getHandler("enqueueTranslateRequest")
  }
  const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
  setupSubtitlesTranslationHandlers()
  return getHandler("enqueueSubtitlesTranslateRequest")
}

function request(
  text: string,
  sender: Sender,
  { config = createProvider(), sessionId = "session", extra = {} } = {},
) {
  const providerRef = { kind: "local" as const, config }
  return {
    data: {
      text,
      langConfig: DEFAULT_CONFIG.language,
      providerRef,
      hash: Sha256Hex(text, getProviderCacheIdentity(providerRef)),
      scheduleAt: Date.now(),
      webTitle: "Same title",
      webDescription: "Same description",
      sessionId,
      glossaryRevision: 4,
      glossaryTerms: [],
      ...extra,
    },
    sender,
  }
}

const prompts = () => mocks.generateText.mock.calls.map(([options]) => options.prompt).sort()

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.ensureInitializedConfig.mockResolvedValue(configFor(createProvider()))
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  mocks.translationCache.get.mockResolvedValue(undefined)
  mocks.translationCache.put.mockResolvedValue(undefined)
  mocks.translationCache.delete.mockResolvedValue(undefined)
  mocks.articleSummaryCache.get.mockResolvedValue(undefined)
  mocks.articleSummaryCache.put.mockResolvedValue(undefined)
  mocks.aiSegmentationCache.get.mockResolvedValue(undefined)
  mocks.aiSegmentationCache.put.mockResolvedValue(undefined)
  mocks.aiSegmentationCache.delete.mockResolvedValue(undefined)
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  mocks.generateText.mockImplementation(async ({ model, prompt }) => ({
    text: prompt
      .split(JOINED)
      .map((text) => `${model.modelId}:${text}`)
      .join(JOINED),
  }))
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Live transport forbidden")),
  )
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.doUnmock("@/utils/host/translate/execute-translate")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(["page", "subtitles"] as const)("%s translation cache", (route) => {
  it("lets a private sender translate without touching the persistent cache", async () => {
    mocks.translationCache.get.mockResolvedValue({
      key: "any",
      translation: "STALE-PERSISTED",
      createdAt: new Date(),
    })
    const handler = await startHandler(route)
    const result = handler(request("private-text", PRIVATE_SENDER))
    await vi.advanceTimersByTimeAsync(100)

    expect(await result).toBe("model-a:private-text")
    expect(mocks.translationCache.get).not.toHaveBeenCalled()
    expect(mocks.translationCache.delete).not.toHaveBeenCalled()
    expect(mocks.translationCache.put).not.toHaveBeenCalled()
    expect(mocks.generateText).toHaveBeenCalledTimes(1)
    // Metadata only (count, provider, model, time) — deliberately unchanged.
    expect(mocks.putBatchRequestRecord).toHaveBeenCalledWith(
      expect.objectContaining({ originalRequestCount: 1 }),
    )
  })

  describe.each(NON_PRIVATE_SENDERS)("for %s", (_label, sender) => {
    it("serves a persistent hit without calling the provider", async () => {
      mocks.translationCache.get.mockResolvedValue({
        key: "any",
        translation: "PERSISTED",
        createdAt: new Date(),
      })
      const handler = await startHandler(route)
      const message = request("normal-text", sender)

      expect(await handler(message)).toBe("PERSISTED")
      expect(mocks.translationCache.get).toHaveBeenCalledExactlyOnceWith(message.data.hash)
      expect(mocks.generateText).not.toHaveBeenCalled()
      expect(mocks.translationCache.put).not.toHaveBeenCalled()
    })

    it("writes a miss to the persistent cache under the unchanged hash", async () => {
      const handler = await startHandler(route)
      const message = request("normal-text", sender)
      const result = handler(message)
      await vi.advanceTimersByTimeAsync(100)

      expect(await result).toBe("model-a:normal-text")
      expect(mocks.translationCache.get).toHaveBeenCalledExactlyOnceWith(message.data.hash)
      expect(mocks.translationCache.put).toHaveBeenCalledExactlyOnceWith({
        key: message.data.hash,
        translation: "model-a:normal-text",
        createdAt: expect.any(Date),
      })
    })
  })
})

describe.each(["page", "subtitles"] as const)("%s request identity", (route) => {
  it.each(["normal first", "private first"] as const)(
    "does not dedup a normal and a private request for the same text (%s)",
    async (order) => {
      const handler = await startHandler(route)
      const normal = request("shared", NORMAL_SENDER, { sessionId: "normal-session" })
      const priv = request("shared", PRIVATE_SENDER, { sessionId: "private-session" })
      expect(normal.data.hash).toBe(priv.data.hash)

      const results = (order === "normal first" ? [normal, priv] : [priv, normal]).map((message) =>
        handler(message),
      )
      await vi.advanceTimersByTimeAsync(100)

      expect(await Promise.all(results)).toEqual(["model-a:shared", "model-a:shared"])
      // Two provider requests, each for the single text — not one deduped item.
      expect(prompts()).toEqual(["shared", "shared"])
      // Only the normal request persists, under its own unchanged hash.
      expect(mocks.translationCache.put).toHaveBeenCalledExactlyOnceWith({
        key: normal.data.hash,
        translation: "model-a:shared",
        createdAt: expect.any(Date),
      })
    },
  )

  it("does not batch a normal and a private paragraph into one provider request", async () => {
    const handler = await startHandler(route)
    const results = [
      handler(request("alpha", NORMAL_SENDER)),
      handler(request("beta", PRIVATE_SENDER)),
    ]
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all(results)).toEqual(["model-a:alpha", "model-a:beta"])
    expect(prompts()).toEqual(["alpha", "beta"])
  })

  it("still batches private paragraphs with each other", async () => {
    const handler = await startHandler(route)
    const results = [
      handler(request("beta", PRIVATE_SENDER)),
      handler(request("gamma", PRIVATE_SENDER)),
    ]
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all(results)).toEqual(["model-a:beta", "model-a:gamma"])
    expect(prompts()).toEqual([`beta${JOINED}gamma`])
  })

  it("still dedups identical private requests with each other", async () => {
    const handler = await startHandler(route)
    const results = [
      handler(request("same", PRIVATE_SENDER, { sessionId: "one" })),
      handler(request("same", PRIVATE_SENDER, { sessionId: "two" })),
    ]
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all(results)).toEqual(["model-a:same", "model-a:same"])
    expect(prompts()).toEqual(["same"])
  })
})

describe("page translation behaviour that must not change", () => {
  it("does not write a private sender's forced retranslation to the persistent cache", async () => {
    const handler = await startHandler("page")
    const result = handler(
      request("private-text", PRIVATE_SENDER, { extra: { forceRetranslation: true } }),
    )
    await vi.advanceTimersByTimeAsync(100)

    expect(await result).toBe("model-a:private-text")
    expect(mocks.translationCache.get).not.toHaveBeenCalled()
    expect(mocks.translationCache.put).not.toHaveBeenCalled()
  })

  it("keeps writing a normal sender's forced retranslation over the cached entry", async () => {
    const handler = await startHandler("page")
    const message = request("normal-text", NORMAL_SENDER, { extra: { forceRetranslation: true } })
    const result = handler(message)
    await vi.advanceTimersByTimeAsync(100)

    expect(await result).toBe("model-a:normal-text")
    expect(mocks.translationCache.get).not.toHaveBeenCalled()
    expect(mocks.translationCache.put).toHaveBeenCalledExactlyOnceWith({
      key: message.data.hash,
      translation: "model-a:normal-text",
      createdAt: expect.any(Date),
    })
  })

  it("cancels a private session without cancelling an identical normal request", async () => {
    const handler = await startHandler("page")
    const priv = request("shared", PRIVATE_SENDER, { sessionId: "private-session" })
    const normal = request("shared", NORMAL_SENDER, { sessionId: "normal-session" })
    const privateResult = handler(priv).catch((error: unknown) => error)
    const normalResult = handler(normal)
    await vi.advanceTimersByTimeAsync(0)
    await getHandler("cancelPageTranslationRequests")({
      data: { sessionId: "private-session" },
      sender: PRIVATE_SENDER,
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(await privateResult).toMatchObject({
      name: "TranslationCancelledError",
      message: "Translation request cancelled (scope: 7:private-session)",
    })
    expect(await normalResult).toBe("model-a:shared")
    expect(prompts()).toEqual(["shared"])
    expect(mocks.translationCache.put).toHaveBeenCalledTimes(1)
  })

  it("keeps deleting a normal sender's cached translation that lost its HTML attribute markers", async () => {
    mocks.translationCache.get.mockResolvedValue({
      key: "any",
      translation: "<a>marker lost</a>",
      createdAt: new Date(),
    })
    const handler = await startHandler("page")
    const result = handler(
      request('<a data-rf-attr="1">link</a>', NORMAL_SENDER, { extra: { textFormat: "html" } }),
    )
    await vi.advanceTimersByTimeAsync(100)
    await result

    expect(mocks.translationCache.delete).toHaveBeenCalledTimes(1)
  })

  it("never reads or deletes the cache for a private sender whose cache holds a marker-less entry", async () => {
    mocks.translationCache.get.mockResolvedValue({
      key: "any",
      translation: "<a>marker lost</a>",
      createdAt: new Date(),
    })
    const handler = await startHandler("page")
    const result = handler(
      request('<a data-rf-attr="1">link</a>', PRIVATE_SENDER, { extra: { textFormat: "html" } }),
    )
    await vi.advanceTimersByTimeAsync(100)
    await result

    expect(mocks.translationCache.get).not.toHaveBeenCalled()
    expect(mocks.translationCache.delete).not.toHaveBeenCalled()
    expect(mocks.translationCache.put).not.toHaveBeenCalled()
  })
})

describe.each(["page", "subtitles"] as const)(
  "%s per-request (non-batch) provider path",
  (route) => {
    function slowExecutor() {
      mocks.executeTranslate.mockImplementation(
        (text: string) => new Promise((resolve) => setTimeout(() => resolve(`local:${text}`), 50)),
      )
      vi.doMock("@/utils/host/translate/execute-translate", () => ({
        executeTranslate: mocks.executeTranslate,
      }))
    }

    it("keeps a private sender's request off the persistent cache", async () => {
      mocks.translationCache.get.mockResolvedValue({
        key: "any",
        translation: "STALE-PERSISTED",
        createdAt: new Date(),
      })
      slowExecutor()
      const handler = await startHandler(route)
      const result = handler(
        request("private-text", PRIVATE_SENDER, { config: createLocalProvider() }),
      )
      await vi.advanceTimersByTimeAsync(100)

      expect(await result).toBe("local:private-text")
      expect(mocks.executeTranslate).toHaveBeenCalledTimes(1)
      expect(mocks.translationCache.get).not.toHaveBeenCalled()
      expect(mocks.translationCache.put).not.toHaveBeenCalled()
    })

    it("does not dedup a normal and a private request for the same text", async () => {
      slowExecutor()
      const handler = await startHandler(route)
      const results = [
        handler(request("shared", NORMAL_SENDER, { config: createLocalProvider() })),
        handler(request("shared", PRIVATE_SENDER, { config: createLocalProvider() })),
      ]
      await vi.advanceTimersByTimeAsync(100)

      expect(await Promise.all(results)).toEqual(["local:shared", "local:shared"])
      expect(mocks.executeTranslate).toHaveBeenCalledTimes(2)
      expect(mocks.translationCache.put).toHaveBeenCalledTimes(1)
    })
  },
)

describe.each([
  {
    route: "page",
    handlerName: "getOrGenerateWebPageSummary",
    payload: (providerRef: unknown) => ({
      webTitle: "Synthetic title",
      webContent: "Synthetic body text that is long enough to summarise.",
      providerRef,
    }),
  },
  {
    route: "subtitles",
    handlerName: "getSubtitlesSummary",
    payload: (providerRef: unknown) => ({
      videoTitle: "Synthetic video",
      subtitlesContext: "Synthetic transcript text that is long enough to summarise.",
      providerRef,
    }),
  },
] as const)("$route summary persistence", ({ route, handlerName, payload }) => {
  const providerRef = { kind: "local" as const, config: createProvider() }

  function slowSummary() {
    mocks.generateTextForProviderRef.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("synthetic summary"), 50)),
    )
  }

  it("generates a private sender's summary without reading or writing the summary cache", async () => {
    mocks.articleSummaryCache.get.mockResolvedValue({ key: "any", summary: "STALE-SUMMARY" })
    slowSummary()
    await startHandler(route)
    const result = getHandler(handlerName)({ data: payload(providerRef), sender: PRIVATE_SENDER })
    await vi.advanceTimersByTimeAsync(100)

    expect(await result).toBe("synthetic summary")
    expect(mocks.generateTextForProviderRef).toHaveBeenCalledTimes(1)
    expect(mocks.articleSummaryCache.get).not.toHaveBeenCalled()
    expect(mocks.articleSummaryCache.put).not.toHaveBeenCalled()
  })

  it.each(NON_PRIVATE_SENDERS)(
    "serves and fills the summary cache for %s",
    async (_label, sender) => {
      slowSummary()
      await startHandler(route)
      mocks.articleSummaryCache.get.mockResolvedValueOnce({
        key: "any",
        summary: "PERSISTED-SUMMARY",
      })
      expect(await getHandler(handlerName)({ data: payload(providerRef), sender })).toBe(
        "PERSISTED-SUMMARY",
      )
      expect(mocks.generateTextForProviderRef).not.toHaveBeenCalled()

      const miss = getHandler(handlerName)({ data: payload(providerRef), sender })
      await vi.advanceTimersByTimeAsync(100)
      expect(await miss).toBe("synthetic summary")
      expect(mocks.articleSummaryCache.put).toHaveBeenCalledExactlyOnceWith({
        key: expect.stringMatching(/^[a-f0-9]{64}$/),
        summary: "synthetic summary",
        createdAt: expect.any(Date),
      })
    },
  )

  it("does not dedup a normal and a private summary request", async () => {
    slowSummary()
    await startHandler(route)
    const results = [
      getHandler(handlerName)({ data: payload(providerRef), sender: NORMAL_SENDER }),
      getHandler(handlerName)({ data: payload(providerRef), sender: PRIVATE_SENDER }),
    ]
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all(results)).toEqual(["synthetic summary", "synthetic summary"])
    expect(mocks.generateTextForProviderRef).toHaveBeenCalledTimes(2)
    expect(mocks.articleSummaryCache.put).toHaveBeenCalledTimes(1)
  })
})

describe("video summary persistence", () => {
  const providerRef = { kind: "local" as const, config: createProvider() }
  const data = { transcript: "Synthetic transcript", targetLanguage: "English", providerRef }

  async function startVideoSummary() {
    const { setupVideoSummaryHandlers } = await import("../video-summary")
    setupVideoSummaryHandlers()
  }

  it("neither reads nor writes the summary cache for a private sender", async () => {
    mocks.articleSummaryCache.get.mockResolvedValue({ key: "any", summary: "STALE-SUMMARY" })
    await startVideoSummary()

    expect(await getHandler("getCachedVideoSummary")({ data, sender: PRIVATE_SENDER })).toBeNull()
    await getHandler("saveVideoSummary")({
      data: { ...data, summary: "Synthetic summary" },
      sender: PRIVATE_SENDER,
    })

    expect(mocks.articleSummaryCache.get).not.toHaveBeenCalled()
    expect(mocks.articleSummaryCache.put).not.toHaveBeenCalled()
  })

  it.each(NON_PRIVATE_SENDERS)(
    "reads and writes the summary cache for %s",
    async (_label, sender) => {
      mocks.articleSummaryCache.get.mockResolvedValue({ key: "any", summary: "PERSISTED-SUMMARY" })
      await startVideoSummary()

      expect(await getHandler("getCachedVideoSummary")({ data, sender })).toBe("PERSISTED-SUMMARY")
      await getHandler("saveVideoSummary")({
        data: { ...data, summary: "Synthetic summary" },
        sender,
      })

      expect(mocks.articleSummaryCache.get).toHaveBeenCalledTimes(1)
      expect(mocks.articleSummaryCache.put).toHaveBeenCalledExactlyOnceWith({
        key: mocks.articleSummaryCache.get.mock.calls[0]![0],
        summary: "Synthetic summary",
        createdAt: expect.any(Date),
      })
    },
  )
})

describe("AI segmentation persistence", () => {
  const providerRef = { kind: "local" as const, config: createProvider() }
  const jsonContent = JSON.stringify([{ s: 1000, e: 2000, t: "synthetic words" }])
  const parseableVtt = "WEBVTT\n\n1000 --> 2000\nSynthetic words."
  const data = { jsonContent, providerRef }

  beforeEach(() => {
    mocks.generateTextForProviderRef.mockResolvedValue(parseableVtt)
  })

  it("segments without touching the cache when persistence is off", async () => {
    // Both a good and a poisoned entry would otherwise be read, and the
    // poisoned one deleted.
    mocks.aiSegmentationCache.get.mockResolvedValue({ key: "any", result: "WEBVTT\n\nno cues" })
    const { runAiSegmentSubtitles } = await import("../ai-segmentation")

    expect(await runAiSegmentSubtitles(data, { persist: false })).toBe(parseableVtt)
    expect(mocks.generateTextForProviderRef).toHaveBeenCalledTimes(1)
    expect(mocks.aiSegmentationCache.get).not.toHaveBeenCalled()
    expect(mocks.aiSegmentationCache.delete).not.toHaveBeenCalled()
    expect(mocks.aiSegmentationCache.put).not.toHaveBeenCalled()
  })

  it("persists by default, as every existing caller expects", async () => {
    const { runAiSegmentSubtitles } = await import("../ai-segmentation")

    expect(await runAiSegmentSubtitles(data)).toBe(parseableVtt)
    expect(mocks.aiSegmentationCache.get).toHaveBeenCalledTimes(1)
    expect(mocks.aiSegmentationCache.put).toHaveBeenCalledTimes(1)
  })

  async function startSegmentationHandler() {
    const { setupAiSegmentationHandlers } = await import("../ai-segmentation")
    setupAiSegmentationHandlers()
    return getHandler("aiSegmentSubtitles")
  }

  it("keeps a private sender's subtitle chunk out of the segmentation cache", async () => {
    mocks.aiSegmentationCache.get.mockResolvedValue({ key: "any", result: parseableVtt })
    const handler = await startSegmentationHandler()

    expect(await handler({ data, sender: PRIVATE_SENDER })).toBe(parseableVtt)
    expect(mocks.generateTextForProviderRef).toHaveBeenCalledTimes(1)
    expect(mocks.aiSegmentationCache.get).not.toHaveBeenCalled()
    expect(mocks.aiSegmentationCache.put).not.toHaveBeenCalled()
  })

  it.each(NON_PRIVATE_SENDERS)("keeps caching segmentation for %s", async (_label, sender) => {
    const handler = await startSegmentationHandler()

    expect(await handler({ data, sender })).toBe(parseableVtt)
    expect(mocks.aiSegmentationCache.get).toHaveBeenCalledTimes(1)
    expect(mocks.aiSegmentationCache.put).toHaveBeenCalledTimes(1)
  })
})
