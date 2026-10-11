import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { createByosService } from "../service"
import { callbackUrl, credentials, memoryVault, mockTransport } from "./auth-fixtures"

const delta = { type: "response.output_text.delta", delta: "첫 자막\n\n%%\n\n둘째 자막" }
const completed = { type: "response.completed", response: { status: "completed" } }
const frame = (event: unknown, newline = "\n") =>
  `data: ${JSON.stringify(event)}${newline}${newline}`

function streamResponse(text: string, contentType = "text/event-stream", chunkSize = 7) {
  const bytes = new Uint8Array(Buffer.from(text, "utf8"))
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close()
          return
        }
        const end = Math.min(offset + chunkSize, bytes.length)
        controller.enqueue(bytes.slice(offset, end))
        offset = end
      },
    }),
    { headers: { "Content-Type": contentType, "x-request-id": "req_synthetic_stream" } },
  )
}

async function invoke(response: Response) {
  const vault = memoryVault()
  await vault.update((record) => {
    record.credentials = credentials()
  })
  const fetcher = vi.fn<typeof fetch>(async () => response)
  const service = createByosService(vault, mockTransport(), "extension", callbackUrl, fetcher)
  return service.invoke({ model: "gpt-6.1-sol", text: "First subtitle\n\n%%\n\nSecond subtitle" })
}

describe("Responses wire stream", () => {
  it.each([
    [
      "refusal-only",
      [
        { type: "response.refusal.delta", delta: "Synthetic private refusal" },
        { type: "response.refusal.done", refusal: "Synthetic private refusal" },
      ],
    ],
    [
      "finalized refusal",
      [{ type: "response.refusal.done", refusal: "Synthetic private refusal" }],
    ],
    [
      "mixed text and refusal",
      [delta, { type: "response.refusal.delta", delta: "Synthetic private refusal" }],
    ],
  ])(
    "rejects completed %s instead of returning empty or partial translation success",
    async (_name, events) => {
      await expect(
        invoke(streamResponse([...events, completed].map((event) => frame(event)).join(""))),
      ).rejects.toMatchObject({
        code: "inference_refused",
        message: "BYOS: inference_refused",
        status: 200,
        requestId: "req_synthetic_stream",
        isRetryable: false,
      })
    },
  )

  it("preserves an upstream failure after refusal instead of hiding it as a completed refusal", async () => {
    const events = [
      { type: "response.refusal.delta", delta: "Synthetic private refusal" },
      {
        type: "response.failed",
        response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
      },
    ]
    await expect(
      invoke(streamResponse(events.map((event) => frame(event)).join(""))),
    ).rejects.toMatchObject({
      code: "subscription_sharing_usage_limit_exceeded",
      isRetryable: false,
    })
  })

  it("does not retry an interrupted refusal as an incomplete inference", async () => {
    await expect(
      invoke(
        streamResponse(
          frame({ type: "response.refusal.delta", delta: "Synthetic private refusal" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "inference_refused", isRetryable: false })
  })

  it("preserves a later transport error as nonretryable after a valid refusal", async () => {
    const bytes = new Uint8Array(
      Buffer.from(
        frame({ type: "response.refusal.delta", delta: "Synthetic private refusal" }),
        "utf8",
      ),
    )
    let reads = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(bytes)
          else controller.error(new TypeError("Synthetic connection interruption"))
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
    await expect(invoke(response)).rejects.toMatchObject({
      message: "Synthetic connection interruption",
      isRetryable: false,
    })
  })

  it.each([
    [{ type: "response.refusal.delta", delta: 42 }, "invalid_stream_delta"],
    [{ type: "response.refusal.done", refusal: 42 }, "invalid_stream_event"],
  ])("rejects malformed refusal event %j with a safe stage", async (event, code) => {
    await expect(invoke(streamResponse(frame(event) + frame(completed)))).rejects.toMatchObject({
      code,
    })
  })

  it("keeps reasoning and lifecycle events out of translated text for a Sol model stream", async () => {
    const events = [
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.in_progress", response: { status: "in_progress" } },
      { type: "response.output_item.added", item: { type: "reasoning" }, output_index: 0 },
      { type: "response.reasoning_summary_part.added", part: { type: "summary_text", text: "" } },
      {
        type: "response.reasoning_summary_text.delta",
        delta: "Synthetic reasoning, not subtitles",
      },
      { type: "response.reasoning_summary_text.done", text: "Synthetic reasoning, not subtitles" },
      { type: "response.output_item.done", item: { type: "reasoning" }, output_index: 0 },
      { type: "response.output_item.added", item: { type: "message" }, output_index: 1 },
      { type: "response.content_part.added", part: { type: "output_text", text: "" } },
      delta,
      { type: "response.output_text.done", text: delta.delta },
      { type: "response.content_part.done", part: { type: "output_text", text: delta.delta } },
      { type: "response.output_item.done", item: { type: "message" }, output_index: 1 },
      completed,
    ]
    await expect(
      invoke(streamResponse(events.map((event) => frame(event)).join(""), undefined, 1)),
    ).resolves.toEqual({
      text: delta.delta,
    })
  })

  it.each(["\n", "\r\n", "\r"])(
    "decodes UTF-8 text and named/commented SSE frames with %j line endings across byte chunks",
    async (newline) => {
      const text =
        `: heartbeat${newline}${newline}` +
        `event: response.output_text.delta${newline}` +
        frame(delta, newline) +
        `event: response.completed${newline}` +
        frame(completed, newline) +
        `data: [DONE]${newline}${newline}`
      await expect(
        invoke(streamResponse(text, "text/event-stream; charset=utf-8", 1)),
      ).resolves.toEqual({
        text: delta.delta,
      })
    },
  )

  it("accepts the case-insensitive event-stream MIME essence", async () => {
    await expect(
      invoke(streamResponse(frame(delta) + frame(completed), "Text/Event-Stream; charset=UTF-8")),
    ).resolves.toEqual({ text: delta.delta })
  })

  it.each([
    ["application/json", JSON.stringify({ object: "response", status: "completed", output: [] })],
    ["application/x-text/event-stream", frame(delta) + frame(completed)],
  ])(
    "rejects %s without nonstreaming fallback and identifies the safe stage",
    async (type, body) => {
      await expect(invoke(streamResponse(body, type))).rejects.toMatchObject({
        code: "invalid_stream_content_type",
        status: 200,
        requestId: "req_synthetic_stream",
      })
    },
  )

  it("identifies a missing streaming body separately", async () => {
    await expect(
      invoke(new Response(null, { headers: { "Content-Type": "text/event-stream" } })),
    ).rejects.toMatchObject({ code: "invalid_stream_body", status: 200 })
  })

  it("does not expose arbitrary response headers or raw body in stage diagnostics", async () => {
    await expect(
      invoke(
        new Response("synthetic-private-body", {
          headers: {
            "Content-Type": "application/json; private=synthetic-private-header",
            "x-request-id": "synthetic-private-identifier",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_stream_content_type",
      message: "BYOS: invalid_stream_content_type",
      status: 200,
      requestId: undefined,
    })
  })

  it.each([
    ["data: synthetic-private-not-json\n\n", "invalid_stream_json"],
    [frame(null), "invalid_stream_event"],
    [frame({ unexpected: "synthetic-private-value" }), "invalid_stream_event"],
    [frame({ type: "response.output_text.delta", delta: 42 }), "invalid_stream_delta"],
    [frame(completed) + frame(delta), "invalid_stream_after_completed"],
  ])("reports only a safe stage for malformed event %j", async (body, code) => {
    await expect(invoke(streamResponse(body))).rejects.toMatchObject({
      code,
      status: 200,
      requestId: "req_synthetic_stream",
      message: `BYOS: ${code}`,
    })
  })

  it("does not accept a terminal event without its SSE frame boundary", async () => {
    await expect(
      invoke(streamResponse(frame(delta) + `data: ${JSON.stringify(completed)}`)),
    ).rejects.toMatchObject({ code: "inference_incomplete" })
  })
})
