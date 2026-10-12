import { generateText } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApiUsageRecorder } from "@/utils/api-usage"
import { installApiUsageObserver } from "@/utils/api-usage-tracking"
import { getLanguageModelForConfig } from "../model"

afterEach(() => {
  vi.unstubAllGlobals()
  installApiUsageObserver(() => {})
})

describe("feature attribution through the real AI SDK provider transport", () => {
  it("counts the SDK retry and preserves actual request routing", async () => {
    let stored: unknown = null
    const recorder = createApiUsageRecorder({
      read: async () => structuredClone(stored),
      write: async (value) => {
        stored = structuredClone(value)
      },
    })
    installApiUsageObserver(recorder.record)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "synthetic rate limit" } },
          { status: 429, headers: { "Retry-After": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "synthetic-completion",
          object: "chat.completion",
          created: 0,
          model: "synthetic-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "translated" },
              finish_reason: "stop",
            },
          ],
        }),
      )
    vi.stubGlobal("fetch", fetcher)
    const model = getLanguageModelForConfig(
      {
        id: "synthetic-provider",
        name: "Synthetic provider",
        provider: "openai-compatible",
        enabled: true,
        baseURL: "https://example.test/v1",
        apiKey: "synthetic-secret",
        model: { model: "use-custom-model", isCustomModel: true, customModel: "synthetic-model" },
      },
      "selectionTranslation",
    )
    const result = await generateText({ model, prompt: "synthetic source", maxRetries: 1 })
    expect(result.text).toBe("translated")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example.test/v1/chat/completions")
    expect((await recorder.snapshot()).usage?.counts.selectionTranslation).toEqual({
      api: 2,
      byos: 0,
    })
    expect(JSON.stringify(stored)).not.toMatch(/synthetic|source|example|secret/)
  })
})
