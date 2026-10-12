import { generateText, Output, streamText } from "ai"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createByosModel } from "../model"
vi.mock("../messages", () => ({ sendByosMessage: vi.fn<typeof fetch>() }))
describe("BYOS AI SDK adapter", () => {
  it("passes a fixed feature label separately from the strict upstream invocation", async () => {
    const invoke = vi.fn<NonNullable<Parameters<typeof createByosModel>[1]>>(async () => ({
      text: "result",
    }))
    await createByosModel("synthetic-model", invoke, "dictionary").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "source" }] }],
    })
    expect(invoke.mock.calls[0]?.[2]).toBe("dictionary")
    expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty("usageFeature")
  })
  it("runs actual generateText pipeline for page translation", async () => {
    const invoke = vi.fn<NonNullable<Parameters<typeof createByosModel>[1]>>(async () => ({
      text: "번역된 페이지",
    }))
    const result = await generateText({
      model: createByosModel("fixture-model", invoke),
      instructions: "Translate into Korean",
      prompt: "Example page",
      maxRetries: 0,
    })
    expect(result.text).toBe("번역된 페이지")
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0]![0]).toEqual({
      model: "fixture-model",
      text: "Example page",
      instructions: "Translate into Korean",
    })
  })
  it("runs structured dictionary stream and validates schema", async () => {
    const schema = z.object({ meaning: z.string(), examples: z.string() })
    const invoke = vi.fn<NonNullable<Parameters<typeof createByosModel>[1]>>(async () => ({
      text: JSON.stringify({ meaning: "뜻", examples: "예문" }),
    }))
    const result = streamText({
      model: createByosModel("fixture-model", invoke),
      prompt: "Explain this word",
      output: Output.object({ schema }),
      maxRetries: 0,
    })
    await result.consumeStream()
    expect(await result.output).toEqual({ meaning: "뜻", examples: "예문" })
    expect(invoke.mock.calls[0]![0].instructions).toContain("JSON schema")
  })
  it("rejects malformed/wrong-schema dictionaries rather than showing partial output", async () => {
    for (const text of ["```json\n{}\n```", '{"meaning": 3}']) {
      await expect(
        generateText({
          model: createByosModel("fixture", async () => ({ text })),
          prompt: "word",
          output: Output.object({ schema: z.object({ meaning: z.string() }) }),
          maxRetries: 0,
        }),
      ).rejects.toThrow("invalid_structured_output")
    }
  })
  it("does not retry/fallback or call anything when already aborted", async () => {
    const invoke = vi.fn<NonNullable<Parameters<typeof createByosModel>[1]>>(async () => {
      throw new Error("BYOS: usage_limit")
    })
    await expect(
      generateText({ model: createByosModel("fixture", invoke), prompt: "word", maxRetries: 0 }),
    ).rejects.toThrow("usage_limit")
    expect(invoke).toHaveBeenCalledOnce()
    invoke.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(
      createByosModel("fixture", invoke).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "word" }] }],
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/./)
    expect(invoke).not.toHaveBeenCalled()
  })
})
