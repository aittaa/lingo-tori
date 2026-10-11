import { readFileSync } from "node:fs"
import { generateText, Output, streamText } from "ai"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
// @ts-expect-error Node-only companion is JavaScript; this regression deliberately crosses the extension/runtime boundary.
import { Companion, SCOPES } from "../../../../apps/companion/src/core.mjs"
import { createByosModel } from "../model"
import { assertByosSender, bridgeConfigSchema, createByosService, invokeSchema } from "../service"
vi.mock("../messages", () => ({ sendByosMessage: vi.fn<typeof fetch>() }))
const secret = "fixture-local-bridge-00000000000000000"
const config = { endpoint: "http://127.0.0.1:4318", secret }
function makeStore() {
  let value: typeof config | undefined = config
  return {
    read: async () => value,
    write: async (next: typeof config | undefined) => {
      value = next
    },
  }
}
describe("BYOS private bridge", () => {
  it("accepts explicit loopback only and rejects remote/token-bearing URLs", () => {
    expect(bridgeConfigSchema.parse(config)).toEqual(config)
    for (const endpoint of [
      "https://example.com",
      "http://localhost:4318",
      "http://127.0.0.1",
      "http://127.0.0.1:4318/path",
      "http://user@127.0.0.1:4318",
      "http://127.0.0.1:4318?token=fixture",
    ])
      expect(() => bridgeConfigSchema.parse({ ...config, endpoint })).toThrow(/./)
  })
  it("requires extension sender and private options page for connection management", () => {
    expect(() =>
      assertByosSender(
        { id: "extension", url: "https://site.example" },
        "extension",
        "chrome-extension://extension/options.html",
      ),
    ).toThrow(/./)
    expect(() => assertByosSender({ id: "other" }, "extension")).toThrow(/./)
    expect(() =>
      assertByosSender(
        { id: "extension", url: "chrome-extension://extension/options.html#/byos" },
        "extension",
        "chrome-extension://extension/options.html",
      ),
    ).not.toThrow(/./)
  })
  it("sends secret only to configured loopback and never returns it from status", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ text: "translated" })),
    )
    const service = createByosService(makeStore(), "chrome-extension://extension", fetcher)
    expect(await service.status()).toEqual({ configured: true, endpoint: config.endpoint })
    expect(await service.invoke({ text: "source", model: "fixture-model" })).toEqual({
      text: "translated",
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${config.endpoint}/v1/translate`)
    expect(options.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${secret}`,
        "X-LingoTori-Extension-Origin": "chrome-extension://extension",
      }),
    )
    expect(options.headers).not.toHaveProperty("Origin")
    expect(options.redirect).toBe("error")
  })
  it("propagates limits with exactly one request and no fallback; redacts unknown diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: { code: "usage_limit" } }), { status: 429 }),
    )
    const service = createByosService(makeStore(), "chrome-extension://extension", fetcher)
    await expect(service.invoke({ text: "source", model: "fixture" })).rejects.toThrow(
      "usage_limit",
    )
    expect(fetcher).toHaveBeenCalledOnce()
    const unsafe = createByosService(
      makeStore(),
      "chrome-extension://extension",
      async () => new Response(JSON.stringify({ error: { code: secret } }), { status: 500 }),
    )
    await expect(unsafe.models()).rejects.toThrow("companion_request_failed")
  })
  it("does not open arbitrary authorization URLs", async () => {
    const service = createByosService(
      makeStore(),
      "chrome-extension://extension",
      async () => new Response(JSON.stringify({ authorizationUrl: "https://evil.example/login" })),
    )
    await expect(service.authStart()).rejects.toThrow("invalid_authorization_url")
  })
  it("forgets pairing without leaking its old secret", async () => {
    const service = createByosService(
      makeStore(),
      "chrome-extension://extension",
      vi.fn<typeof fetch>(),
    )
    await service.configure(null)
    expect(await service.status()).toEqual({ configured: false, endpoint: "" })
    await expect(service.models()).rejects.toThrow("connection_not_configured")
  })
})
describe("BYOS AI SDK adapter", () => {
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

it("accepts the actual long built-in dictionary instructions with structured output", async () => {
  const localeSource = readFileSync(new URL("../../../locales/en.yml", import.meta.url), "utf8")
  const template = localeSource
    .split("      templates:")[1]
    ?.split("          systemPrompt: |-\n")[1]
    ?.split("          prompt: |-")[0]
  expect(template).toBeDefined()
  const instructions = template!.replace(/^            /gm, "")
  expect(instructions.length).toBeGreaterThan(4000)
  let upstreamCalls = 0
  const companion = new Companion({
    store: {
      read: async () => ({
        access_token: "synthetic-access",
        scopes: SCOPES.split(" "),
        expires_at: Date.now() + 3600000,
      }),
      write: async () => {},
    },
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    fetcher: async (url: string, options: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/responses")
      const body = JSON.parse(options.body as string)
      expect(body.instructions).toContain("JSON schema")
      expect(body.instructions.length).toBeGreaterThan(4000)
      upstreamCalls++
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"{\\\"Definition\\\":\\\"A flower\\\"}"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  await companion.initialize()
  const invoke: NonNullable<Parameters<typeof createByosModel>[1]> = async (payload, signal) => {
    invokeSchema.parse(payload)
    return companion.translate(payload, signal)
  }
  const result = await generateText({
    model: createByosModel("fixture", invoke),
    instructions,
    prompt: "blossom",
    output: Output.object({ schema: z.object({ Definition: z.string() }) }),
    maxRetries: 0,
  })
  expect(result.output).toEqual({ Definition: "A flower" })
  expect(upstreamCalls).toBe(1)
})
