// @vitest-environment node
import type { LLMProviderConfig } from "@/types/config/provider"
import type { ApiUsageFeature } from "@/utils/api-usage"
import { generateText } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deeplTranslate } from "@/utils/host/translate/api/deepl"
import { deeplxTranslate } from "@/utils/host/translate/api/deeplx"
import { getLanguageModelForConfig } from "../model"

/**
 * Provider requests carry the user's page, subtitle and summary text and the model's answer.
 * The browser must never keep those response bodies in its on-disk HTTP cache, so every
 * provider fetch has to reach `fetch` with `cache: "no-store"` — private windows included.
 *
 * These tests drive the real model factories, `generateText` and the DeepL/DeepLX adapters
 * against a stubbed `globalThis.fetch`; nothing touches the network.
 */

const CHAT_COMPLETION = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "mock-model",
  choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const RESPONSES_RESULT = {
  id: "resp-test",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "mock-model",
  output: [
    {
      type: "message",
      id: "msg-test",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

const OLLAMA_CHAT = {
  model: "mock-model",
  created_at: "2026-01-01T00:00:00Z",
  message: { role: "assistant", content: "pong" },
  done: true,
  done_reason: "stop",
  total_duration: 1,
  load_duration: 1,
  prompt_eval_count: 1,
  prompt_eval_duration: 1,
  eval_count: 1,
  eval_duration: 1,
}

const MODEL = { model: "use-custom-model", isCustomModel: true, customModel: "mock-model" } as const
// Dedicated providers keep a preset id in `model` (the schema is an enum per provider) and carry a
// custom id in `customModel`, so the wire model is still "mock-model".
const DEEPSEEK_MODEL = {
  model: "deepseek-v4-flash",
  isCustomModel: true,
  customModel: "mock-model",
} as const
const OLLAMA_MODEL = { model: "gemma3:4b", isCustomModel: true, customModel: "mock-model" } as const
const ORIGIN = "https://provider.example.test"

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function urlOf(input: RequestInfo | URL) {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

function jsonBodyOf(init?: RequestInit): unknown {
  expect(typeof init?.body).toBe("string")
  return JSON.parse(init?.body as string)
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input) => {
    const url = urlOf(input)
    if (url.endsWith("/chat/completions")) return jsonResponse(CHAT_COMPLETION)
    if (url.endsWith("/responses")) return jsonResponse(RESPONSES_RESULT)
    if (url.endsWith("/api/chat")) return jsonResponse(OLLAMA_CHAT)
    if (url.endsWith("/v2/translate")) return jsonResponse({ translations: [{ text: "Bonjour" }] })
    if (url.includes("deeplx")) return jsonResponse({ code: 200, data: "Bonjour" })
    return new Response("not found", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every request that left the extension must have asked the browser not to cache it. */
function expectEveryRequestNoStore() {
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
  for (const [, init] of fetchMock.mock.calls) {
    expect(init?.cache).toBe("no-store")
  }
}

const LLM_CONFIGS: Array<[string, LLMProviderConfig]> = [
  [
    "openai-compatible",
    {
      id: "openai-compatible-test",
      name: "Custom endpoint",
      enabled: true,
      provider: "openai-compatible",
      baseURL: `${ORIGIN}/v1`,
      apiKey: "sk-test-123",
      model: MODEL,
    },
  ],
  [
    "open-responses",
    {
      id: "open-responses-test",
      name: "Custom endpoint",
      enabled: true,
      provider: "open-responses",
      url: `${ORIGIN}/v1/responses`,
      apiKey: "sk-test-123",
      model: MODEL,
    },
  ],
  [
    "deepseek (dedicated factory)",
    {
      id: "deepseek-test",
      name: "DeepSeek",
      enabled: true,
      provider: "deepseek",
      baseURL: `${ORIGIN}/v1`,
      apiKey: "sk-test-123",
      model: DEEPSEEK_MODEL,
    },
  ],
  [
    "ollama (own client)",
    {
      id: "ollama-test",
      name: "Ollama",
      enabled: true,
      provider: "ollama",
      baseURL: ORIGIN,
      model: OLLAMA_MODEL,
    },
  ],
]

const USAGE_FEATURES: Array<[string, ApiUsageFeature | undefined]> = [
  ["without a usage feature", undefined],
  ["with a usage feature", "pageTranslation"],
]

describe("LLM provider requests are issued with cache: no-store", () => {
  describe.each(LLM_CONFIGS)("%s", (_name, config) => {
    it.each(USAGE_FEATURES)("%s", async (_label, usageFeature) => {
      const model = getLanguageModelForConfig(config, usageFeature)
      const result = await generateText({ model, prompt: "ping", maxRetries: 0 })

      expect(result.text).toBe("pong")
      expectEveryRequestNoStore()
    })
  })

  it("leaves the method, headers and body of the request unchanged", async () => {
    const [, config] = LLM_CONFIGS[0]!
    const model = getLanguageModelForConfig(config, "pageTranslation")
    await generateText({ model, prompt: "ping", maxRetries: 0 })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(urlOf(url)).toBe(`${ORIGIN}/v1/chat/completions`)
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-123")
    expect(jsonBodyOf(init)).toMatchObject({ model: "mock-model" })
  })
})

describe("DeepL and DeepLX requests are issued with cache: no-store", () => {
  const deepl = {
    id: "deepl-test",
    name: "DeepL",
    enabled: true,
    provider: "deepl",
    apiKey: "test-key:fx",
  } as const
  const deeplx = {
    id: "deeplx-test",
    name: "DeepLX",
    enabled: true,
    provider: "deeplx",
    baseURL: "https://deeplx.example.test/translate",
  } as const

  it.each(USAGE_FEATURES)("DeepL %s", async (_label, usageFeature) => {
    const translated = await deeplTranslate("Hello", "auto", "fr", deepl, { usageFeature })

    expect(translated).toBe("Bonjour")
    expectEveryRequestNoStore()
  })

  it.each(USAGE_FEATURES)("DeepLX %s", async (_label, usageFeature) => {
    const translated = await deeplxTranslate("Hello", "auto", "fr", deeplx, { usageFeature })

    expect(translated).toBe("Bonjour")
    expectEveryRequestNoStore()
  })

  it("keeps the DeepL request itself intact while adding the cache mode", async () => {
    await deeplTranslate("Hello", "auto", "fr", deepl, { usageFeature: "pageTranslation" })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api-free.deepl.com/v2/translate")
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { Authorization: "DeepL-Auth-Key test-key:fx" },
    })
    expect(jsonBodyOf(init)).toEqual({ text: ["Hello"], target_lang: "FR" })
  })
})
