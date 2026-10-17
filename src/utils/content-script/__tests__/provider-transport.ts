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

const FINISH_PARTS = [
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

const SSE_INIT = { status: 200, headers: { "content-type": "text/event-stream" } }

function sse(content: string) {
  const encoder = new TextEncoder()
  const parts = [
    chunk({ role: "assistant", content: "" }, null),
    chunk({ content }, null),
    ...FINISH_PARTS,
  ]
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        controller.close()
      },
    }),
    SSE_INIT,
  )
}

/** What a test can observe about the response bodies that are held open after their first chunk. */
interface HeldBodyStats {
  /** Bodies errored because their request's signal aborted while they were open. */
  aborted: number
  /** Bodies the reader cancelled while they were open. */
  cancelled: number
  /** Whether the held tail was written to a body that was still open. */
  tailDelivered: boolean
}

/**
 * The response comes back at once with the role chunk and the first content chunk already
 * readable; the rest of the content, the finish chunks and the end of the stream wait for
 * `released`. Aborting the request's signal while the body is open errors the body with an
 * AbortError, as `fetch` does, and a body that has errored (or was cancelled) takes no later
 * chunk: a tail released after that is dropped.
 */
function heldSse(
  firstContent: string,
  restContent: string,
  signal: AbortSignal | null | undefined,
  released: Promise<void>,
  stats: HeldBodyStats,
) {
  const encoder = new TextEncoder()
  const head = [
    chunk({ role: "assistant", content: "" }, null),
    chunk({ content: firstContent }, null),
  ]
  const tail = [chunk({ content: restContent }, null), ...FINISH_PARTS]
  let open = true
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of head) controller.enqueue(encoder.encode(part))
        signal?.addEventListener(
          "abort",
          () => {
            if (!open) return
            open = false
            stats.aborted++
            controller.error(new DOMException("aborted", "AbortError"))
          },
          { once: true },
        )
        void released.then(() => {
          if (!open) return
          open = false
          for (const part of tail) controller.enqueue(encoder.encode(part))
          controller.close()
          stats.tailDelivered = true
        })
      },
      cancel() {
        if (!open) return
        open = false
        stats.cancelled++
      },
    }),
    SSE_INIT,
  )
}

/**
 * `content` is what the "provider" streams back: plain text, or a JSON object for a structured run.
 * With `hold`, each request waits for `respond()`; one whose signal aborts first is rejected with an
 * AbortError and counted in `aborted`.
 *
 * With `holdBody` (a prefix of `content`), the response is returned at once and its body delivers
 * only that prefix as the first content chunk; the rest of `content` and the end of the stream are
 * written by `releaseBody()`. A request aborted while its body is held is counted in `bodyAborted`
 * (the reader cancelling the body is counted in `bodyCancelled`), and `tailDelivered` says whether
 * the late tail reached a body that was still open. Without `holdBody` the whole body is readable
 * at once, as before.
 */
export function installProviderTransport(
  content: string,
  options: { hold?: boolean; holdBody?: string } = {},
) {
  if (options.holdBody !== undefined && !content.startsWith(options.holdBody)) {
    throw new Error("`holdBody` must be a prefix of `content`")
  }
  const requests: OutboundProviderRequest[] = []
  let aborted = 0
  const heldBodies: HeldBodyStats = { aborted: 0, cancelled: 0, tailDelivered: false }
  const waiting: Array<() => void> = []
  let releaseBody!: () => void
  const bodyReleased = new Promise<void>((resolve) => {
    releaseBody = resolve
  })
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
    if (options.holdBody === undefined) return sse(content)
    return heldSse(
      options.holdBody,
      content.slice(options.holdBody.length),
      init?.signal,
      bodyReleased,
      heldBodies,
    )
  })
  vi.stubGlobal("fetch", stub)
  return {
    requests,
    stub,
    get aborted() {
      return aborted
    },
    get bodyAborted() {
      return heldBodies.aborted
    },
    get bodyCancelled() {
      return heldBodies.cancelled
    },
    get tailDelivered() {
      return heldBodies.tailDelivered
    },
    respond: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
    releaseBody,
  }
}
