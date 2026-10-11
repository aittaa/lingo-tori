import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR } from "@/utils/constants/prompt"
import { Sha256Hex } from "@/utils/hash"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"

interface ModelSettings {
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

interface GenerateOptions {
  model: ModelSettings & { modelId: string }
  prompt: string
  temperature?: number
  providerOptions?: unknown
}

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn<(...args: any[]) => any>(),
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  cacheGet: vi.fn<(...args: any[]) => any>(),
  cachePut: vi.fn<(...args: any[]) => any>(),
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
}))

// The production handlers, BatchQueue, RequestQueue, executeTranslate,
// aiTranslate and model/config helpers stay real. Only application I/O,
// prompt construction and SDK transport are replaced; no live call is possible.
vi.mock("@/utils/message", () => ({ onMessage: mocks.onMessage }))
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

function createProvider(label: "a" | "b") {
  return {
    id: "same-provider",
    name: "Captured provider",
    provider: "openai-compatible" as const,
    enabled: true,
    baseURL: `https://snapshot-${label}.example/v1`,
    apiKey: `synthetic-key-${label}`,
    headers: { "X-Snapshot": label },
    model: {
      model: "use-custom-model" as const,
      isCustomModel: true as const,
      customModel: `model-${label}`,
    },
    temperature: label === "a" ? 0.1 : 0.9,
    providerOptions: { snapshot: label },
  }
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

function getHandler(name: string) {
  const handler = mocks.onMessage.mock.calls.find(([registered]) => registered === name)?.[1]
  if (typeof handler !== "function") throw new Error(`Missing handler: ${name}`)
  return handler as (message: {
    data: Record<string, unknown>
    sender?: { tab: { id: number } }
  }) => Promise<string>
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

function request(text: string, config: LLMProviderConfig, sessionId = "snapshot-session") {
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
    },
    sender: { tab: { id: 39 } },
  }
}

function expectSnapshotCall(config: ReturnType<typeof createProvider>, prompt: string) {
  expect(mocks.generateText).toHaveBeenCalledWith(
    expect.objectContaining({
      model: expect.objectContaining({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        headers: config.headers,
        modelId: config.model.customModel,
      }),
      prompt,
      temperature: config.temperature,
      providerOptions: { "openai-compatible": config.providerOptions },
    }),
  )
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.ensureInitializedConfig.mockResolvedValue(configFor(createProvider("a")))
  mocks.cacheGet.mockResolvedValue(undefined)
  mocks.cachePut.mockResolvedValue(undefined)
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  mocks.generateText.mockImplementation(async ({ model, prompt }) => ({
    text: `<think>synthetic</think>${prompt
      .split(JOINED)
      .map((text) => `${model.modelId}:${text}`)
      .join(JOINED)}`,
  }))
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Live transport forbidden")),
  )
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(["page", "subtitles"] as const)("%s batch provider snapshots", (route) => {
  it.each([
    "all",
    "baseURL",
    "apiKey",
    "headers",
    "model",
    "temperature",
    "providerOptions",
  ] as const)("separates the same provider ID when %s changes before flush", async (field) => {
    const captured = createProvider("a")
    const edited = createProvider("b")
    const current = field === "all" ? edited : { ...captured, [field]: edited[field] }
    const handler = await startHandler(route)
    const firstMessage = request("private-a", captured)
    const first = handler(firstMessage)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.generateText).not.toHaveBeenCalled()

    // A remains pending when storage changes and the second request captures B.
    await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, configFor(current))
    const reads = vi.spyOn(storage, "getItem")
    const secondMessage = request("private-b", current)
    const second = handler(secondMessage)
    await vi.advanceTimersByTimeAsync(100)

    const results = await Promise.all([first, second])
    expect(mocks.cachePut).toHaveBeenCalledWith(
      expect.objectContaining({
        key: secondMessage.data.hash,
        translation: `${current.model.customModel}:private-b`,
      }),
    )
    expect(results).toEqual([
      `${captured.model.customModel}:private-a`,
      `${current.model.customModel}:private-b`,
    ])
    expect(mocks.generateText).toHaveBeenCalledTimes(2)
    expectSnapshotCall(captured, "private-a")
    expectSnapshotCall(current, "private-b")
    expect(reads).not.toHaveBeenCalled()
    expect(
      mocks.putBatchRequestRecord.mock.calls.map(([record]) => record.originalRequestCount),
    ).toEqual([1, 1])
  })

  it("still batches separately captured copies of an unchanged snapshot", async () => {
    const captured = createProvider("a")
    const handler = await startHandler(route)
    const first = handler(request("one", captured))
    const second = handler(request("two", structuredClone(captured)))
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all([first, second])).toEqual(["model-a:one", "model-a:two"])
    expect(mocks.generateText).toHaveBeenCalledTimes(1)
    expectSnapshotCall(captured, `one${JOINED}two`)
    expect(mocks.putBatchRequestRecord).toHaveBeenCalledWith(
      expect.objectContaining({ originalRequestCount: 2 }),
    )
  })
})

it("cancels an old page snapshot without cancelling the new snapshot's scope", async () => {
  const handler = await startHandler("page")
  const first = handler(request("cancelled", createProvider("a"), "old")).catch(
    (error: unknown) => error,
  )
  const second = handler(request("active", createProvider("b"), "new"))
  await vi.advanceTimersByTimeAsync(0)
  await getHandler("cancelPageTranslationRequests")({
    data: { sessionId: "old" },
    sender: { tab: { id: 39 } },
  })
  await vi.advanceTimersByTimeAsync(100)

  expect(await first).toMatchObject({
    name: "TranslationCancelledError",
    message: "Translation request cancelled (scope: 39:old)",
  })
  expect(await second).toBe("model-b:active")
  expect(mocks.generateText).toHaveBeenCalledTimes(1)
  expectSnapshotCall(createProvider("b"), "active")
  expect(mocks.cachePut).toHaveBeenCalledTimes(1)
})
