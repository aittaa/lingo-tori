import type { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"
import { invokeByos } from "./invoke"
import { ByosBridgeError } from "./service"
type Model = ReturnType<ReturnType<typeof createOpenAI>["languageModel"]>
type CallOptions = Parameters<Model["doGenerate"]>[0]
type Invoker = typeof invokeByos
const usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}
export function createByosModel(modelId: string, invoke: Invoker = invokeByos): Model {
  if (!modelId.trim()) throw new ByosBridgeError("model_required")
  async function generate(options: CallOptions) {
    options.abortSignal?.throwIfAborted()
    if (options.tools?.length) throw new ByosBridgeError("tools_not_supported")
    const instructions: string[] = [],
      messages: { role: string; text: string }[] = []
    for (const message of options.prompt) {
      if (message.role === "system") {
        instructions.push(message.content)
        continue
      }
      const texts: string[] = []
      for (const part of message.content) {
        if (part.type !== "text") throw new ByosBridgeError("text_only")
        texts.push(part.text)
      }
      messages.push({ role: message.role, text: texts.join("\n") })
    }
    let schema: z.ZodType | undefined
    if (options.responseFormat?.type === "json") {
      instructions.push("Return only a valid JSON object. Do not use Markdown code fences.")
      if (options.responseFormat.schema) {
        // Validate the output locally as well as through the caller's existing
        // AI SDK/Zod schema; never display malformed dictionary objects.
        schema = z.fromJSONSchema(
          options.responseFormat.schema as Parameters<typeof z.fromJSONSchema>[0],
        )
        instructions.push(
          `Match this JSON schema: ${JSON.stringify(options.responseFormat.schema)}`,
        )
      }
    }
    const { text } = await invoke(
      {
        model: modelId,
        text:
          messages.length === 1 && messages[0]?.role === "user"
            ? messages[0].text
            : JSON.stringify(messages),
        instructions: instructions.join("\n\n"),
      },
      options.abortSignal,
    )
    options.abortSignal?.throwIfAborted()
    if (options.responseFormat?.type === "json") {
      try {
        const value: unknown = JSON.parse(text)
        if (schema) schema.parse(value)
      } catch {
        throw new ByosBridgeError("invalid_structured_output")
      }
    }
    return text
  }
  return {
    specificationVersion: "v4",
    provider: "lingotori.byos",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const text = await generate(options)
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "completed" },
        usage,
        warnings: [],
      }
    },
    async doStream(options) {
      // Emit a completed result only after the invocation succeeds.
      const text = await generate(options)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "text-start", id: "byos" })
            controller.enqueue({ type: "text-delta", id: "byos", delta: text })
            controller.enqueue({ type: "text-end", id: "byos" })
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "completed" },
              usage,
            })
            controller.close()
          },
        }),
      }
    },
  }
}
