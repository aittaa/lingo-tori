import type { ProvidersConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { RequestQueue } from "@/utils/request/request-queue"
import { aiTranslate } from "../ai"

interface ModelFactorySettings {
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

const mocks = vi.hoisted(() => ({
  generateText: vi
    .fn<
      (options: {
        model: unknown
        temperature?: number
        providerOptions?: unknown
      }) => Promise<{ text: string }>
    >()
    .mockResolvedValue({ text: "translated" }),
  createOpenAICompatible: vi.fn<
    (settings: ModelFactorySettings) => {
      languageModel: (modelId: string) => ModelFactorySettings & { modelId: string }
    }
  >((settings) => ({
    languageModel: (modelId: string) => ({ modelId, ...settings }),
  })),
}))

vi.mock("ai", () => ({ generateText: mocks.generateText }))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))
// Keep the real model factory and provider predicates. Only storage/application
// defaults and the SDK transport are isolated; no request can leave the test.
vi.mock("@/utils/constants/config", () => ({ CONFIG_STORAGE_KEY: "config" }))
vi.mock("@/utils/config/helpers", async () => {
  const { isLLMProviderConfig } = await import("@/types/config/provider")
  return {
    getLLMProvidersConfig: (providers: ProvidersConfig) => providers.filter(isLLMProviderConfig),
    getProviderConfigById: (providers: ProvidersConfig, id: string) =>
      providers.find((provider) => provider.id === id),
  }
})

function createProvider(label: "a" | "b") {
  return {
    id: "queued-provider",
    name: `Provider ${label}`,
    provider: "openai-compatible" as const,
    enabled: true,
    baseURL: `https://snapshot-${label}.example/v1`,
    apiKey: `test-key-${label}`,
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

const promptResolver = async (_target: string, text: string) => ({
  systemPrompt: "Translate the queued text.",
  prompt: text,
})

describe("queued AI provider snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"))
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(["edited", "deleted"] as const)(
    "keeps queued text on the captured endpoint when its stored provider is %s",
    async (change) => {
      const captured = createProvider("a")
      const current = createProvider("b")
      const getItem = vi.spyOn(storage, "getItem")
      getItem.mockResolvedValue({ providersConfig: [captured] })
      const queue = new RequestQueue({
        rate: 1,
        capacity: 1,
        timeoutMs: 1000,
        maxRetries: 0,
        baseRetryDelayMs: 1,
      })
      const scheduled = queue.enqueue(
        () => aiTranslate("queued private text", "Korean", captured, promptResolver),
        Date.now() + 100,
        "snapshot-test",
      )
      // Attach rejection handling before advancing timers: the old deletion
      // path rejects during dispatch and must not produce an unhandled error.
      const result = scheduled.then(
        (text) => ({ text }),
        (error: unknown) => ({ error }),
      )
      expect(mocks.generateText).not.toHaveBeenCalled()
      getItem.mockResolvedValue({ providersConfig: change === "edited" ? [current] : [] })

      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toEqual({ text: "translated" })
      expect(mocks.generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.objectContaining({
            baseURL: captured.baseURL,
            apiKey: captured.apiKey,
            headers: captured.headers,
            modelId: captured.model.customModel,
          }),
          prompt: "queued private text",
          temperature: captured.temperature,
          providerOptions: { "openai-compatible": captured.providerOptions },
        }),
      )
    },
  )
})
