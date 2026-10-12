import { generateText, streamText } from "ai"
import { describe, expect, it, vi } from "vitest"
import { createByosModel } from "../model"
import { createByosService } from "../service"
import { callbackUrl, credentials, memoryVault, mockTransport } from "./auth-fixtures"

async function setup(usage: unknown, terminated = true) {
  const vault = memoryVault()
  await vault.update((value) => {
    value.credentials = credentials()
  })
  const body = `data: {"type":"response.output_text.delta","delta":"synthetic output"}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}${terminated ? "\n\n" : ""}`
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  )
  const service = createByosService(vault, mockTransport(), "extension", callbackUrl, fetcher)
  const model = createByosModel("synthetic-model", (payload, signal) =>
    service.invoke(payload, signal),
  )
  return { service, model, fetcher }
}

describe("BYOS optional reported usage", () => {
  it("passes actual input/output and cache subset through generateText without estimating or double adding", async () => {
    const { model, fetcher } = await setup({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 60 },
      output_tokens_details: { reasoning_tokens: 10 },
    })
    const result = await generateText({ model, prompt: "synthetic input", maxRetries: 0 })
    expect(result.text).toBe("synthetic output")
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 60 },
      outputTokenDetails: { reasoningTokens: 10 },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("passes a reported zero through streaming while absent/invalid usage remains undefined", async () => {
    const measured = await setup({ input_tokens: 0, output_tokens: 0 })
    const result = streamText({ model: measured.model, prompt: "synthetic", maxRetries: 0 })
    await result.consumeStream()
    expect(await result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    for (const usage of [undefined, null, { input_tokens: "100", output_tokens: -1 }]) {
      const missing = await setup(usage)
      const response = await generateText({
        model: missing.model,
        prompt: "synthetic",
        maxRetries: 0,
      })
      expect(response.usage.inputTokens).toBeUndefined()
      expect(response.usage.outputTokens).toBeUndefined()
      expect(missing.fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it("does not accept usage on a truncated completion frame or alter non-retryable stream protection", async () => {
    const { service, fetcher } = await setup({ input_tokens: 100, output_tokens: 20 }, false)
    await expect(
      service.invoke({ model: "synthetic-model", text: "source" }),
    ).rejects.toMatchObject({ code: "inference_incomplete", isRetryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
