// The provider's network edge for tests that run the real AI SDK and the real model factories:
// `globalThis.fetch` is replaced with a recorder that answers an OpenAI-compatible chat completion
// as a server-sent-event stream. Nothing leaves the process.

import { vi } from "vitest"

export interface OutboundProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, any>
}

function chunk(delta: Record<string, unknown>, finishReason: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function sse(content: string) {
  const encoder = new TextEncoder()
  const parts = [
    chunk({ role: "assistant", content: "" }, null),
    chunk({ content }, null),
    chunk({}, "stop"),
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "echo",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ]
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

/**
 * `content` is what the "provider" streams back: plain text, or a JSON object for a structured run.
 * With `hold`, each request waits for `respond()`; one whose signal aborts first is rejected with an
 * AbortError and counted in `aborted`.
 */
export function installProviderTransport(content: string, options: { hold?: boolean } = {}) {
  const requests: OutboundProviderRequest[] = []
  let aborted = 0
  const waiting: Array<() => void> = []
  const stub = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const raw = typeof init?.body === "string" ? init.body : "{}"
    requests.push({ url, method: init?.method ?? "GET", headers, body: JSON.parse(raw) })
    if (options.hold) {
      await new Promise<void>((resolve, reject) => {
        waiting.push(resolve)
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted++
            reject(new DOMException("aborted", "AbortError"))
          },
          { once: true },
        )
      })
    }
    return sse(content)
  })
  vi.stubGlobal("fetch", stub)
  return {
    requests,
    stub,
    get aborted() {
      return aborted
    },
    respond: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
  }
}
