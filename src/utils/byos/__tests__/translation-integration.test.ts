import type { LLMProviderConfig } from "@/types/config/provider"
import type { getModelById } from "@/utils/providers/model"
import { Buffer } from "node:buffer"
import { beforeEach, expect, it, vi } from "vitest"
import { aiTranslate } from "@/utils/host/translate/api/ai"
import { BatchQueue } from "@/utils/request/batch-queue"
import { RequestQueue } from "@/utils/request/request-queue"
import { getRequestErrorMeta } from "@/utils/request/retry-policy"
import { createByosModel } from "../model"
import { RESOURCE } from "../oidc"
import { createByosService } from "../service"
import { credentials, fetchUrl, memoryVault, mockTransport } from "./auth-fixtures"

const mocks = vi.hoisted(() => ({ getModel: vi.fn<typeof getModelById>() }))
vi.mock("@/utils/providers/model", () => ({ getModelById: mocks.getModel }))

const provider: LLMProviderConfig = {
  id: "synthetic-video-provider",
  name: "ChatGPT",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: "synthetic-video-model" },
}
const source = "First subtitle\n\n%%\n\nSecond subtitle"
const translated = "첫 번째 자막\n\n%%\n\n두 번째 자막"
const instructions = "Translate subtitles into Korean and preserve standalone %% separators."
const prompt = async (_language: string, input: string) => ({
  systemPrompt: instructions,
  prompt: input,
})

beforeEach(() => mocks.getModel.mockReset())

async function prepare(fetcher: typeof fetch) {
  const vault = memoryVault()
  await vault.update((record) => {
    record.credentials = credentials()
  })
  const service = createByosService(
    vault,
    mockTransport(),
    "extension",
    "chrome-extension://extension/byos-callback.html",
    fetcher,
  )
  mocks.getModel.mockResolvedValue(
    createByosModel("synthetic-video-model", (payload, signal) => service.invoke(payload, signal)),
  )
  return service
}

function refusalFetcher() {
  return vi.fn<typeof fetch>(async () => {
    const events = [
      { type: "response.refusal.delta", delta: "Synthetic private refusal" },
      { type: "response.refusal.done", refusal: "Synthetic private refusal" },
      { type: "response.completed", response: { status: "completed" } },
    ]
    return new Response(
      new Uint8Array(
        Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), "utf8"),
      ),
      { headers: { "Content-Type": "text/event-stream", "x-request-id": "req_synthetic_refusal" } },
    )
  })
}

it("propagates a safe nonretryable refusal through the actual SDK without invalidating the account", async () => {
  const fetcher = refusalFetcher()
  const service = await prepare(fetcher)
  const error: unknown = await aiTranslate(source, "Korean", provider, prompt, {
    isBatch: true,
  }).catch((caught: unknown) => caught)
  expect(error).toMatchObject({
    code: "inference_refused",
    message: "BYOS: inference_refused",
    requestId: "req_synthetic_refusal",
  })
  expect(getRequestErrorMeta(error).isRetryable).toBe(false)
  expect(await service.session()).toMatchObject({ state: "plan-enabled", authPending: false })
  expect(fetcher).toHaveBeenCalledOnce()
})

it("does not retry a refused subtitle batch or fall back to individual requests", async () => {
  const fetcher = refusalFetcher()
  await prepare(fetcher)
  const requests = new RequestQueue({
    rate: 10,
    capacity: 10,
    timeoutMs: 1000,
    maxRetries: 2,
    baseRetryDelayMs: 1,
  })
  const individual = vi.fn<() => Promise<string>>(async () => "unexpected fallback")
  const executeBatch = vi.fn<(items: { text: string }[]) => Promise<string[]>>(async (items) => {
    const result = await requests.enqueue(
      (signal) =>
        aiTranslate(items.map((item) => item.text).join("\n\n%%\n\n"), "Korean", provider, prompt, {
          isBatch: true,
          signal,
        }),
      Date.now(),
      "synthetic-refusal-batch",
    )
    return result.split("\n\n%%\n\n")
  })
  const batch = new BatchQueue<{ text: string }, string>({
    maxCharactersPerBatch: 1000,
    maxItemsPerBatch: 2,
    batchDelay: 100,
    maxRetries: 0,
    enableFallbackToIndividual: true,
    getBatchKey: () => "synthetic-refusal-batch",
    getCharacters: (item) => item.text.length,
    executeBatch,
    executeIndividual: individual,
  })
  const results = await Promise.allSettled([
    batch.enqueue({ text: "First subtitle" }),
    batch.enqueue({ text: "Second subtitle" }),
  ])
  expect(fetcher).toHaveBeenCalledOnce()
  expect(executeBatch).toHaveBeenCalledOnce()
  expect(individual).not.toHaveBeenCalled()
  for (const result of results) {
    expect(result).toMatchObject({ status: "rejected", reason: { code: "inference_refused" } })
  }
})

it("carries subtitle batch text through host translation, the real SDK adapter and the Responses transport", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    expect(fetchUrl(input)).toBe(`${RESOURCE}/responses`)
    expect(options?.method).toBe("POST")
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer synthetic-access")
    if (typeof options?.body !== "string") throw new Error("Expected a JSON request body")
    expect(JSON.parse(options.body)).toEqual({
      model: "synthetic-video-model",
      instructions,
      input: [{ role: "user", content: source }],
      store: false,
      stream: true,
    })
    const events = [
      { type: "response.output_text.delta", delta: translated },
      { type: "response.completed", response: { status: "completed" } },
    ]
    // The shared jsdom encoder shim truncates non-ASCII code points. Supply
    // actual UTF-8 network bytes rather than letting that shim encode a string.
    const bytes = new Uint8Array(
      Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), "utf8"),
    )
    return new Response(bytes, {
      headers: { "Content-Type": "text/event-stream" },
    })
  })
  await prepare(fetcher)
  expect(await aiTranslate(source, "Korean", provider, prompt, { isBatch: true })).toBe(translated)
  expect(mocks.getModel).toHaveBeenCalledWith(provider.id)
  expect(fetcher).toHaveBeenCalledOnce()
})

it("preserves a safe request failure through subtitle translation without retry or provider fallback", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "model_not_found",
            param: "model",
            message: "Do not expose this raw body",
          },
        }),
        { status: 404, headers: { "x-request-id": "req_synthetic" } },
      ),
  )
  await prepare(fetcher)
  await expect(
    aiTranslate(source, "Korean", provider, prompt, { isBatch: true }),
  ).rejects.toMatchObject({
    code: "model_not_found",
    status: 404,
    param: "model",
    requestId: "req_synthetic",
    message: "BYOS: model_not_found",
  })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(mocks.getModel).toHaveBeenCalledOnce()
})
