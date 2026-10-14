// @vitest-environment node
import type { AddressInfo } from "node:net"
import type {
  OpenAICompatibleLLMProviderConfig,
  OpenResponsesLLMProviderConfig,
} from "@/types/config/provider"
import { createServer } from "node:http"
import { generateText } from "ai"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getLanguageModelForConfig } from "../model"

/**
 * These tests drive the real factory path — `getLanguageModelForConfig`, the real
 * `@ai-sdk/openai-compatible` / `@ai-sdk/open-responses` adapters and the real `generateText`
 * — against a loopback server, and look at the credential headers that actually reach the wire.
 * Nothing in the SDK is mocked.
 */

interface ReceivedRequest {
  path: string
  authorization: string | undefined
  apiKeyHeaders: Record<string, string>
}

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

const MODEL = {
  model: "use-custom-model",
  isCustomModel: true,
  customModel: "mock-model",
} as const

const EXPLICIT_AUTHORIZATION = { Authorization: "Bearer from-header" }

let received: ReceivedRequest[] = []
let origin = ""
let closeServer: () => Promise<void>

beforeAll(async () => {
  const server = createServer((req, res) => {
    const apiKeyHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (/api-?key/i.test(name)) apiKeyHeaders[name] = String(value)
    }
    received.push({ path: req.url ?? "", authorization: req.headers.authorization, apiKeyHeaders })
    req.resume()
    req.on("end", () => {
      const path = req.url ?? ""
      const body = path.endsWith("/chat/completions")
        ? CHAT_COMPLETION
        : path.endsWith("/responses")
          ? RESPONSES_RESULT
          : undefined
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" })
      res.end(JSON.stringify(body ?? { error: { message: "not found" } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
})

afterAll(async () => {
  await closeServer()
})

beforeEach(() => {
  received = []
})

function openAICompatibleConfig(
  apiKey: string | undefined,
  headers?: Record<string, string>,
): OpenAICompatibleLLMProviderConfig {
  return {
    id: "openai-compatible-test",
    name: "Custom endpoint",
    enabled: true,
    provider: "openai-compatible",
    baseURL: `${origin}/v1`,
    model: MODEL,
    ...(apiKey !== undefined && { apiKey }),
    ...(headers && { headers }),
  }
}

function openResponsesConfig(
  apiKey: string | undefined,
  headers?: Record<string, string>,
): OpenResponsesLLMProviderConfig {
  return {
    id: "open-responses-test",
    name: "Custom endpoint",
    enabled: true,
    provider: "open-responses",
    url: `${origin}/v1/responses`,
    model: MODEL,
    ...(apiKey !== undefined && { apiKey }),
    ...(headers && { headers }),
  }
}

type ConfigFactory = (apiKey: string | undefined, headers?: Record<string, string>) => unknown

const ENDPOINTS: Array<{ provider: string; makeConfig: ConfigFactory; path: string }> = [
  {
    provider: "openai-compatible",
    makeConfig: openAICompatibleConfig,
    path: "/v1/chat/completions",
  },
  { provider: "open-responses", makeConfig: openResponsesConfig, path: "/v1/responses" },
]

/** Sends one real request through the production model factory and reports what arrived. */
async function send(config: unknown) {
  const model = getLanguageModelForConfig(
    config as OpenAICompatibleLLMProviderConfig | OpenResponsesLLMProviderConfig,
  )
  const result = await generateText({ model, prompt: "ping", maxRetries: 0 })
  expect(result.text).toBe("pong")
  expect(received).toHaveLength(1)
  const request = received[0]
  if (!request) throw new Error("expected one request")
  return request
}

describe.each(ENDPOINTS)("$provider custom endpoint credentials on the wire", (endpoint) => {
  describe("without an explicit Authorization header", () => {
    it.each([
      ["undefined", undefined],
      ["an empty string", ""],
      ["spaces only", "   "],
      ["a tab and newline", "\t\n"],
    ])("sends no credential header for an API key of %s", async (_label, apiKey) => {
      const request = await send(endpoint.makeConfig(apiKey))

      expect(request.path).toBe(endpoint.path)
      expect(request.authorization).toBeUndefined()
      expect(request.apiKeyHeaders).toEqual({})
    })

    it("sends a real API key unmodified as a bearer token", async () => {
      const request = await send(endpoint.makeConfig("sk-test-123"))

      expect(request.authorization).toBe("Bearer sk-test-123")
    })
  })

  describe("with an explicit Authorization header", () => {
    it.each([
      ["no API key", undefined],
      ["a spaces-only API key", "   "],
      ["a real API key", "sk-test-123"],
    ])("keeps the explicit header with %s", async (_label, apiKey) => {
      const request = await send(endpoint.makeConfig(apiKey, EXPLICIT_AUTHORIZATION))

      expect(request.authorization).toBe("Bearer from-header")
      expect(request.apiKeyHeaders).toEqual({})
    })
  })
})
