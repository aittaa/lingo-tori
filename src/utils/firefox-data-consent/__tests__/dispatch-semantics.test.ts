// @vitest-environment node
//
// Two things that hold for every dispatch gate:
// - Usage metering runs after admission. A request that is refused for missing consent never left
//   the extension, so it is not counted as an API dispatch. One that is admitted is counted once.
// - A refusal is final for the request queue. The queue retries an unknown failure with backoff;
//   a refusal is not a transient failure, and a retry that comes after a revocation is refused too.

import type { LLMProviderConfig } from "@/types/config/provider"
import { generateText } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installApiUsageObserver } from "@/utils/api-usage-tracking"
import { deeplTranslate } from "@/utils/host/translate/api/deepl"
import { getLanguageModelForConfig } from "@/utils/providers/model"
import { RequestQueue } from "@/utils/request/request-queue"
import {
  installFirefox,
  NOTHING_GRANTED,
  removePermissionsDouble,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

const ORIGIN = "https://provider.example.test"

const withKey = {
  id: "openai-compatible-test",
  name: "Custom endpoint",
  enabled: true,
  provider: "openai-compatible",
  baseURL: `${ORIGIN}/v1`,
  apiKey: "sk-test-123",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "mock-model" },
} as LLMProviderConfig

const deepl = {
  id: "deepl-test",
  name: "DeepL",
  enabled: true,
  provider: "deepl",
  apiKey: "test-key:fx",
} as const

const CHAT_COMPLETION = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "mock-model",
  choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
const observer = vi.fn<(...args: unknown[]) => void>()

function answer(input: RequestInfo | URL) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/chat/completions")) return Response.json(CHAT_COMPLETION)
  if (url.endsWith("/v2/translate")) return Response.json({ translations: [{ text: "Bonjour" }] })
  return new Response("not found", { status: 404 })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input) => answer(input))
  observer.mockReset()
  installApiUsageObserver(observer)
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  installApiUsageObserver(() => {})
  vi.unstubAllGlobals()
  removePermissionsDouble()
})

const ask = () =>
  generateText({
    model: getLanguageModelForConfig(withKey, "pageTranslation"),
    prompt: "ping",
    maxRetries: 0,
  })

describe("usage metering runs after admission", () => {
  it("does not count a refused provider request as an API dispatch", async () => {
    installFirefox(NOTHING_GRANTED)

    await expect(ask()).rejects.toMatchObject({ name: "DataConsentRequiredError" })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(observer).not.toHaveBeenCalled()
  })

  it("does not count a refused DeepL request either", async () => {
    installFirefox(NOTHING_GRANTED)

    await expect(
      deeplTranslate("Hello", "auto", "fr", deepl, { usageFeature: "pageTranslation" }),
    ).rejects.toMatchObject({ name: "DataConsentRequiredError" })

    expect(observer).not.toHaveBeenCalled()
  })

  it("counts an admitted request exactly once", async () => {
    installFirefox(WITH_CREDENTIALS)

    await ask()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it("counts a request after a revocation as nothing, and the one before it as one", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    await ask()
    permissions.report(NOTHING_GRANTED)

    await expect(ask()).rejects.toMatchObject({ name: "DataConsentRequiredError" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledTimes(1)
  })
})

describe("the request queue", () => {
  const queue = () =>
    new RequestQueue({
      rate: 1000,
      capacity: 10,
      timeoutMs: 10_000,
      maxRetries: 3,
      baseRetryDelayMs: 5,
    })
  const translate = () =>
    deeplTranslate("Hello", "auto", "fr", deepl, { usageFeature: "pageTranslation" })

  it("makes one attempt when the first one is refused, and does not retry it", async () => {
    installFirefox(NOTHING_GRANTED)
    const attempts = vi.fn<typeof translate>(translate)

    await expect(queue().enqueue(attempts, Date.now(), "hash-1")).rejects.toMatchObject({
      name: "DataConsentRequiredError",
    })

    expect(attempts).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("retries a transient failure, and refuses the retry that comes after a revocation", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    fetchMock.mockImplementationOnce(async () => {
      permissions.report(NOTHING_GRANTED)
      return new Response("overloaded", { status: 503 })
    })
    const attempts = vi.fn<typeof translate>(translate)

    await expect(queue().enqueue(attempts, Date.now(), "hash-2")).rejects.toMatchObject({
      name: "DataConsentRequiredError",
    })

    // The transient failure was retried once; the retry was refused and was not retried in turn.
    expect(attempts).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("still retries an ordinary transient failure when consent is in place", async () => {
    installFirefox(WITH_CREDENTIALS)
    fetchMock.mockImplementationOnce(async () => new Response("overloaded", { status: 503 }))
    const attempts = vi.fn<typeof translate>(translate)

    await expect(queue().enqueue(attempts, Date.now(), "hash-3")).resolves.toBe("Bonjour")

    expect(attempts).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
