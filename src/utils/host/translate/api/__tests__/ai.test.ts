import type { LLMProviderConfig } from "@/types/config/provider"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"
import { aiTranslate } from "../ai"

const mocks = vi.hoisted(() => ({
  generateText: vi.fn<(...args: any[]) => any>(),
  getLanguageModelForConfig: vi.fn<(...args: any[]) => any>(),
  resolveModelId: vi.fn<(...args: any[]) => any>(),
  getProviderOptionsWithOverride: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

vi.mock("@/utils/providers/model", () => ({
  getLanguageModelForConfig: mocks.getLanguageModelForConfig,
}))

vi.mock("@/utils/providers/model-id", () => ({
  resolveModelId: mocks.resolveModelId,
}))

vi.mock("@/utils/providers/options", () => ({
  getProviderOptionsWithOverride: mocks.getProviderOptionsWithOverride,
}))

const providerConfig: LLMProviderConfig = {
  id: "openai-default",
  name: "OpenAI",
  provider: "openai",
  enabled: true,
  apiKey: "sk-test",
  model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
}

const promptResolver = vi.fn<(...args: any[]) => any>().mockResolvedValue({
  systemPrompt: "system",
  prompt: "prompt",
})

describe("aiTranslate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLanguageModelForConfig.mockReturnValue("model")
    mocks.resolveModelId.mockReturnValue("gpt-5-mini")
    mocks.getProviderOptionsWithOverride.mockReturnValue({})
  })

  it.each([
    ["plain translation", "번역된 자막", "번역된 자막"],
    ["multiline plain translation", "첫 줄\n\n%%\n\n둘째 줄", "첫 줄\n\n%%\n\n둘째 줄"],
    ["thinking wrapper", "<think>private reasoning</think>번역된 자막", "번역된 자막"],
    [
      "multiline thinking wrapper",
      "<think>reasoning\ncontinues</think>첫 줄\n둘째 줄",
      "첫 줄\n둘째 줄",
    ],
    ["empty thinking suffix", "<think>reasoning</think>", ""],
    ["empty output", "", ""],
  ])("preserves %s without requiring a thinking tag", async (_label, text, expected) => {
    mocks.generateText.mockResolvedValue({ text })
    expect(await aiTranslate("source", "Korean", providerConfig, promptResolver)).toBe(expected)
  })
  it("preserves AI SDK error metadata for retry policy decisions", async () => {
    const rateLimitedError = Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: {
        "retry-after": "2",
      },
    })
    mocks.generateText.mockRejectedValue(rateLimitedError)

    const error = await aiTranslate("hello", "Chinese", providerConfig, promptResolver).catch(
      (caughtError) => caughtError,
    )

    expect(error).toBe(rateLimitedError)
    expect(getRequestErrorMeta(error)).toEqual(
      expect.objectContaining({
        statusCode: 429,
        isRetryable: true,
        retryAfterMs: 2000,
        kind: "rate-limit",
      }),
    )
  })

  it("preserves response body as the display message when the AI SDK message is generic", async () => {
    const responseBody = '{"code":404,"message":"模型 Kimi-K2-Instruct-09051 无效","data":{}}'
    const invalidModelError = Object.assign(new Error("Something went wrong"), {
      statusCode: 404,
      isRetryable: false,
      responseBody,
    })
    mocks.generateText.mockRejectedValue(invalidModelError)

    const error = await aiTranslate("hello", "Chinese", providerConfig, promptResolver).catch(
      (caughtError) => caughtError,
    )

    expect(error).toBe(invalidModelError)
    expect(error.message).toBe(responseBody)
    expect(getRequestErrorMeta(error)).toEqual(
      expect.objectContaining({
        statusCode: 404,
        isRetryable: false,
        kind: "bad-request",
      }),
    )
  })
})
