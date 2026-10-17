import type { Browser } from "#imports"
import type { BackgroundGenerateTextPayload } from "@/types/background-generate-text"
import type {
  BackgroundNoteSuggestionStreamSnapshot,
  BackgroundStreamNoteSuggestionSerializablePayload,
  BackgroundStreamPortName,
  BackgroundStreamSnapshot,
  BackgroundStreamStructuredObjectSerializablePayload,
  BackgroundStreamTextSerializablePayload,
  BackgroundStructuredObjectOutputField,
  BackgroundStructuredObjectStreamSnapshot,
  BackgroundTextStreamSnapshot,
  StartMessageParseResult,
  StreamPortHandler,
  StreamPortRequestMessage,
  StreamPortResponse,
  StreamPortResponseWithoutStreamRequestId,
  StreamRuntimeOptions,
  ThinkingSnapshot,
} from "@/types/background-stream"
import type { LLMProviderConfig, TranslateProviderConfig } from "@/types/config/provider"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { ErrorAction } from "@/utils/error-action"
import { generateText, Output, parsePartialJson, streamText } from "ai"
import { z } from "zod"
import { BACKGROUND_STREAM_PORTS } from "@/types/background-stream"
import { isLLMProviderConfig, llmProviderConfigItemSchema } from "@/types/config/provider"
import { selectionToolbarCustomActionOutputTypeSchema } from "@/types/config/selection-toolbar"
import { createStructuredObjectSchema } from "@/utils/ai/structured-object-schema"
import { classifyFailureReason } from "@/utils/analytics-failure-reason"
import { apiUsageFeatureSchema } from "@/utils/api-usage"
import { createApiUsageReporter } from "@/utils/api-usage-tracking"
import { extractAISDKErrorMessage } from "@/utils/error/extract-message"
import {
  assertDataConsentAll,
  dataCategoriesSchema,
  findDataConsentError,
} from "@/utils/firefox-data-consent"
import { logger } from "@/utils/logger"
import { noteSuggestionEnvelopeSchema } from "@/utils/note-suggestion/types"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"
import { getLanguageModelForConfig, getModelById } from "@/utils/providers/model"

type MeteredPartStream = {
  stream: AsyncIterable<unknown>
  reporter: ReturnType<typeof createApiUsageReporter>
}

const invalidStreamStartPayloadMessage = "Invalid stream start payload"
const aiStreamProtocolErrorMessage = "Invalid AI stream response."
const aiOutputValidationErrorMessage = "AI output does not match the expected format."
const aiOutputLengthLimitErrorMessage =
  "The AI output reached the length limit. Please reduce the requested output length and try again."

type AiStreamPart = Record<string, unknown> & { type: string }

function createStreamAbortError(message: string) {
  return new DOMException(message, "AbortError")
}

function isAbortLikeError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

const streamPortStartEnvelopeSchema = z.object({
  type: z.literal("start"),
  streamRequestId: z.string().trim().min(1),
  payload: z.unknown(),
})

const streamDataCategoriesSchema = dataCategoriesSchema

const baseStreamPayloadSchema = z
  .object({
    providerId: z.string().trim().min(1),
    usageFeature: apiUsageFeatureSchema.catch("sharedRequests").optional(),
    dataCategories: streamDataCategoriesSchema,
  })
  .loose()

const streamTextPayloadSchema = baseStreamPayloadSchema
  .extend({
    providerKind: z.literal("local"),
    providerConfig: llmProviderConfigItemSchema.optional(),
  })
  .refine(({ providerId, providerConfig }) => !providerConfig || providerConfig.id === providerId)

const structuredObjectFieldSchema = z.object({
  name: z.string().trim().min(1),
  type: selectionToolbarCustomActionOutputTypeSchema,
})

const structuredObjectPayloadSchema = z
  .object({
    providerId: z.string().trim().min(1),
    usageFeature: apiUsageFeatureSchema.catch("sharedRequests").optional(),
    dataCategories: streamDataCategoriesSchema,
    // Validated exactly as the text stream's configuration: a known LLM provider shape whose id is
    // the request's provider id.
    providerConfig: llmProviderConfigItemSchema.optional(),
    outputSchema: z.array(structuredObjectFieldSchema).min(1),
  })
  .loose()
  .superRefine((payload, ctx) => {
    if (payload.providerConfig && payload.providerConfig.id !== payload.providerId) {
      ctx.addIssue({
        code: "custom",
        message: "providerConfig.id must equal providerId.",
        path: ["providerConfig", "id"],
      })
    }

    const nameSet = new Set<string>()

    payload.outputSchema.forEach((field, index) => {
      if (nameSet.has(field.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate output schema name "${field.name}".`,
          path: ["outputSchema", index, "name"],
        })
        return
      }
      nameSet.add(field.name)
    })
  })

function createStartMessageParser<TSerializablePayload>(payloadSchema: z.ZodTypeAny) {
  return (msg: unknown): StartMessageParseResult<TSerializablePayload> => {
    const envelopeResult = streamPortStartEnvelopeSchema.safeParse(msg)
    if (!envelopeResult.success) {
      return { success: false }
    }

    const payloadResult = payloadSchema.safeParse(envelopeResult.data.payload)
    if (!payloadResult.success) {
      return {
        success: false,
        streamRequestId: envelopeResult.data.streamRequestId,
      }
    }

    return {
      success: true,
      message: {
        type: "start",
        streamRequestId: envelopeResult.data.streamRequestId,
        payload: payloadResult.data as TSerializablePayload,
      },
    }
  }
}

function createStreamPortHandler<TSerializablePayload, TResponse>(
  streamFn: (
    serializablePayload: TSerializablePayload,
    options: StreamRuntimeOptions<TResponse>,
  ) => Promise<TResponse>,
  startMessageParser: (msg: unknown) => StartMessageParseResult<TSerializablePayload>,
) {
  return (port: Browser.runtime.Port) => {
    const abortController = new AbortController()
    let isActive = true
    let hasStarted = false
    let streamRequestId: string | undefined
    let messageListener: ((rawMessage: unknown) => void) | undefined
    let disconnectListener: (() => void) | undefined

    const safePost = (response: StreamPortResponseWithoutStreamRequestId<TResponse>) => {
      if (!isActive || abortController.signal.aborted || !streamRequestId) {
        return
      }
      try {
        const message: StreamPortResponse<TResponse> = {
          ...response,
          streamRequestId,
        }
        port.postMessage(message)
      } catch (error) {
        logger.error("[Background] Stream port post failed", error)
      }
    }

    const cleanup = () => {
      if (!isActive) {
        return
      }
      isActive = false
      if (messageListener) {
        port.onMessage.removeListener(messageListener)
      }
      if (disconnectListener) {
        port.onDisconnect.removeListener(disconnectListener)
      }
    }

    disconnectListener = () => {
      abortController.abort(createStreamAbortError("stream port disconnected"))
      cleanup()
    }

    messageListener = async (rawMessage: unknown) => {
      const requestMessage = rawMessage as
        | StreamPortRequestMessage<TSerializablePayload>
        | undefined
      if (requestMessage?.type === "ping") {
        return
      }

      if (hasStarted) {
        return
      }

      const parseResult = startMessageParser(rawMessage)
      if (!parseResult.success) {
        if (parseResult.streamRequestId) {
          streamRequestId = parseResult.streamRequestId
          safePost({
            type: "error",
            error: { message: invalidStreamStartPayloadMessage },
          })
        }

        cleanup()
        try {
          port.disconnect()
        } catch {
          // The port may already be closed due to a race with onDisconnect.
          // This is expected during cleanup and safe to ignore.
        }
        return
      }

      const startMessage = parseResult.message
      streamRequestId = startMessage.streamRequestId
      hasStarted = true
      let streamError: unknown

      try {
        // The payload names the optional Firefox data categories it sends (the page URL, say). Ask
        // for them before anything starts, so a refusal costs nothing, and keep the field out of the
        // model call. This early read is not the check that counts: the categories travel on as
        // runtime options and are read again at each provider dispatch, including SDK retries.
        const { dataCategories, ...streamPayload } =
          startMessage.payload as TSerializablePayload & {
            dataCategories?: Array<"browsingActivity">
          }
        await assertDataConsentAll(dataCategories ?? [])

        const result = await streamFn(streamPayload as TSerializablePayload, {
          signal: abortController.signal,
          dataCategories,
          onChunk: (snapshot) => {
            safePost({ type: "chunk", data: snapshot })
          },
          onError: (error) => {
            if (streamError === undefined) {
              streamError = error
            }
          },
        })

        if (streamError !== undefined) {
          throw streamError instanceof Error
            ? new Error(streamError.message, { cause: streamError })
            : new Error(typeof streamError === "string" ? streamError : "Unknown stream error")
        }

        if (!abortController.signal.aborted) {
          safePost({ type: "done", data: result })
        }
      } catch (error) {
        // A refusal for missing consent may come back wrapped (a stream error, an SDK retry error):
        // report the refusal itself.
        const thrown = streamError ?? error
        const finalError = findDataConsentError(thrown) ?? thrown
        if (abortController.signal.aborted || isAbortLikeError(finalError)) {
          return
        }

        logger.error("[Background] Stream Function failed", finalError)
        safePost({
          type: "error",
          error: {
            message: extractAISDKErrorMessage(finalError),
            action: finalError instanceof BackgroundStreamError ? finalError.action : undefined,
            reason: classifyFailureReason(finalError),
          },
        })
      } finally {
        cleanup()
        try {
          port.disconnect()
        } catch {
          // The port may already be closed due to a race with onDisconnect.
          // This is expected during cleanup and safe to ignore.
        }
      }
    }

    port.onMessage.addListener(messageListener)
    port.onDisconnect.addListener(disconnectListener)
  }
}

function createStreamSnapshot<TOutput>(
  output: TOutput,
  thinking: ThinkingSnapshot,
): BackgroundStreamSnapshot<TOutput> {
  return {
    output: output !== null && typeof output === "object" ? { ...output } : output,
    thinking: { ...thinking },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

class BackgroundStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number; action?: ErrorAction },
  ) {
    super(message, { cause: options?.cause })
    this.retryAfterMs = options?.retryAfterMs
    this.action = options?.action
  }

  readonly retryAfterMs?: number
  readonly action?: ErrorAction
}

function toAiStreamPart(part: unknown): AiStreamPart {
  if (!isRecord(part) || typeof part.type !== "string" || part.type.trim().length === 0) {
    throw new BackgroundStreamError("stream_protocol_error", aiStreamProtocolErrorMessage)
  }

  return part as AiStreamPart
}

function getStringPartField(part: Record<string, unknown>, field: string): string {
  const value = part[field]
  if (typeof value !== "string") {
    throw new BackgroundStreamError("stream_protocol_error", aiStreamProtocolErrorMessage)
  }

  return value
}

function getStreamPartError(part: Record<string, unknown>): unknown {
  return "error" in part
    ? part.error
    : new BackgroundStreamError("stream_protocol_error", aiStreamProtocolErrorMessage)
}

function getStreamFinishReason(part: Record<string, unknown>): string | undefined {
  return typeof part.finishReason === "string" ? part.finishReason : undefined
}

/**
 * Reasoning is over once the answer starts coming out, so the first output delta
 * closes the thinking phase. Models that emit no reasoning at all never send
 * `reasoning-end`, and without this they would stay "thinking" for the whole
 * stream while their output is already rendering. Models that interleave need no
 * special case: a later `reasoning-delta` reopens the phase on its own.
 */
function endThinkingOnOutput(thinking: ThinkingSnapshot): ThinkingSnapshot {
  return thinking.status === "thinking" ? { ...thinking, status: "complete" } : thinking
}

function validateFinishedStream(hasFinish: boolean, finishReason: string | undefined): void {
  if (!hasFinish) {
    throw new BackgroundStreamError("stream_protocol_error", aiStreamProtocolErrorMessage)
  }

  if (finishReason === "length") {
    throw new BackgroundStreamError("output_validation_failed", aiOutputLengthLimitErrorMessage)
  }
}

async function consumeTextPartStream(
  partStream: AsyncIterable<unknown>,
  options: {
    onChunk?: StreamRuntimeOptions<BackgroundTextStreamSnapshot>["onChunk"]
    signal?: AbortSignal
  },
): Promise<BackgroundTextStreamSnapshot> {
  const { onChunk, signal } = options
  let cumulativeText = ""
  let thinking: ThinkingSnapshot = {
    status: "thinking",
    text: "",
  }
  let hasFinish = false
  let finishReason: string | undefined

  for await (const rawPart of partStream) {
    if (signal?.aborted) {
      throw new DOMException("stream aborted", "AbortError")
    }

    const part = toAiStreamPart(rawPart)
    switch (part.type) {
      case "text-delta": {
        cumulativeText += getStringPartField(part, "text")
        thinking = endThinkingOnOutput(thinking)
        onChunk?.(createStreamSnapshot(cumulativeText, thinking))
        break
      }
      case "reasoning-start": {
        thinking = {
          ...thinking,
          status: "thinking",
        }
        break
      }
      case "reasoning-delta": {
        thinking = {
          status: "thinking",
          text: thinking.text + getStringPartField(part, "text"),
        }
        onChunk?.(createStreamSnapshot(cumulativeText, thinking))
        break
      }
      case "reasoning-end": {
        thinking = {
          ...thinking,
          status: "complete",
        }
        onChunk?.(createStreamSnapshot(cumulativeText, thinking))
        break
      }
      case "reasoning-file": {
        break
      }
      case "finish": {
        hasFinish = true
        finishReason = getStreamFinishReason(part)
        break
      }
      case "error": {
        throw getStreamPartError(part)
      }
      default: {
        break
      }
    }
  }

  validateFinishedStream(hasFinish, finishReason)

  thinking = {
    ...thinking,
    status: "complete",
  }

  return createStreamSnapshot(cumulativeText, thinking)
}

async function consumeStructuredObjectPartStream<TOutput extends Record<string, unknown>>(
  partStream: AsyncIterable<unknown>,
  options: {
    objectSchema: z.ZodType<TOutput>
    onChunk?: StreamRuntimeOptions<BackgroundStructuredObjectStreamSnapshot>["onChunk"]
    signal?: AbortSignal
  },
): Promise<BackgroundStreamSnapshot<TOutput>> {
  const { objectSchema, onChunk, signal } = options
  let cumulativeText = ""
  let cumulativeValue: Record<string, unknown> = {}
  let thinking: ThinkingSnapshot = {
    status: "thinking",
    text: "",
  }
  let hasFinish = false
  let finishReason: string | undefined

  for await (const rawPart of partStream) {
    if (signal?.aborted) {
      throw new DOMException("stream aborted", "AbortError")
    }

    const part = toAiStreamPart(rawPart)
    switch (part.type) {
      case "text-delta": {
        cumulativeText += getStringPartField(part, "text")
        thinking = endThinkingOnOutput(thinking)
        const partial = await parsePartialJson(cumulativeText)
        if (isRecord(partial.value)) {
          cumulativeValue = { ...cumulativeValue, ...partial.value }
          onChunk?.(createStreamSnapshot(cumulativeValue, thinking))
        }
        break
      }
      case "reasoning-start": {
        thinking = {
          ...thinking,
          status: "thinking",
        }
        break
      }
      case "reasoning-delta": {
        thinking = {
          status: "thinking",
          text: thinking.text + getStringPartField(part, "text"),
        }
        onChunk?.(createStreamSnapshot(cumulativeValue, thinking))
        break
      }
      case "reasoning-end": {
        thinking = {
          ...thinking,
          status: "complete",
        }
        onChunk?.(createStreamSnapshot(cumulativeValue, thinking))
        break
      }
      case "reasoning-file": {
        break
      }
      case "finish": {
        hasFinish = true
        finishReason = getStreamFinishReason(part)
        break
      }
      case "error": {
        throw getStreamPartError(part)
      }
      default: {
        break
      }
    }
  }

  validateFinishedStream(hasFinish, finishReason)

  try {
    const finalJson = await parsePartialJson(cumulativeText)
    const finalValue = objectSchema.parse(finalJson.value)
    thinking = {
      ...thinking,
      status: "complete",
    }

    return createStreamSnapshot(finalValue, thinking)
  } catch (error) {
    throw new BackgroundStreamError("output_validation_failed", aiOutputValidationErrorMessage, {
      cause: error,
    })
  }
}

/**
 * The runtime options for the model builders: present only when the stream declares a category, so
 * a stream that declares none calls them exactly as before.
 */
function consentRuntimeArgs(dataCategories: StreamRuntimeOptions["dataCategories"]) {
  return dataCategories?.length ? ([{ dataCategories }] as const) : ([] as const)
}

async function createLocalTextPartStream(
  serializablePayload: Extract<BackgroundStreamTextSerializablePayload, { providerKind: "local" }>,
  options: StreamRuntimeOptions<BackgroundTextStreamSnapshot> = {},
): Promise<MeteredPartStream> {
  const {
    providerKind: _providerKind,
    providerId,
    providerConfig,
    usageFeature = "sharedRequests",
    ...streamTextParams
  } = serializablePayload
  const { signal, onError, dataCategories } = options

  const model = providerConfig
    ? getLanguageModelForConfig(providerConfig, usageFeature, ...consentRuntimeArgs(dataCategories))
    : await getModelById(providerId, usageFeature, ...consentRuntimeArgs(dataCategories))
  const reporter = createApiUsageReporter(model, usageFeature)
  const result = streamText({
    ...(streamTextParams as Parameters<typeof streamText>[0]),
    ...(providerConfig ? buildLocalGenerateTextParams(providerConfig) : {}),
    model,
    abortSignal: signal,
    onFinish: ({ totalUsage }) => {
      reporter.observe(totalUsage)
    },
    onError: ({ error }) => {
      onError?.(error)
    },
  })

  return { stream: result.stream, reporter }
}

export async function generateTextForProviderRef(
  payload: BackgroundGenerateTextPayload,
  options: { signal?: AbortSignal; usageFeature?: ApiUsageFeature } = {},
): Promise<string> {
  const { providerRef, instructions, prompt, maxRetries } = payload
  const { signal } = options

  if (signal?.aborted) {
    throw new DOMException("stream aborted", "AbortError")
  }

  // Local text generation needs a real LLM: pure translate providers (DeepLX,
  // Google, Microsoft) have no model to prompt. The payload type already says
  // LLM, but the wire is a trust boundary — a pre-update content script can
  // still send a translate-only ref — so re-widen and check for real.
  const localConfig = providerRef?.config as TranslateProviderConfig | undefined
  if (!localConfig || !isLLMProviderConfig(localConfig)) {
    throw new BackgroundStreamError(
      "invalid_request",
      `Provider "${localConfig?.id ?? "unconfigured"}" cannot generate text`,
    )
  }

  // Built from the config the ref carries, not looked up by id: every other
  // parameter below already comes from the ref, so re-reading storage would
  // pair a model from the current row with reasoning/temperature/providerOptions
  // computed from the snapshot the caller captured — and would fail outright
  // for a row deleted from another tab while the config was already in hand.
  const model = getLanguageModelForConfig(providerRef.config, options.usageFeature)
  const reporter = createApiUsageReporter(model, options.usageFeature)
  try {
    const { text, usage } = await generateText({
      model,
      instructions,
      prompt,
      // maxRetries: 0 — retries belong to the RequestQueue, which meters them
      // against the token bucket; ai-sdk's hidden default (2) would issue extra
      // HTTP attempts invisible to the rate limiter.
      maxRetries: maxRetries ?? 0,
      abortSignal: signal,
      ...buildLocalGenerateTextParams(providerRef.config),
    })
    reporter.observe(usage)
    return text.trim()
  } finally {
    reporter.finish()
  }
}

export async function runStreamTextInBackground(
  serializablePayload: BackgroundStreamTextSerializablePayload,
  options: StreamRuntimeOptions<BackgroundTextStreamSnapshot> = {},
): Promise<BackgroundTextStreamSnapshot> {
  const { signal, onChunk } = options

  if (signal?.aborted) {
    throw new DOMException("stream aborted", "AbortError")
  }

  const { stream: partStream, reporter } = await createLocalTextPartStream(
    serializablePayload,
    options,
  )

  try {
    return await consumeTextPartStream(partStream, { onChunk, signal })
  } finally {
    reporter.finish()
  }
}

async function createLocalStructuredObjectPartStream<TOutput extends Record<string, unknown>>(
  serializablePayload: BackgroundStreamNoteSuggestionSerializablePayload & {
    outputSchema?: BackgroundStructuredObjectOutputField[]
    providerConfig?: LLMProviderConfig
  },
  objectSchema: z.ZodType<TOutput>,
  options: StreamRuntimeOptions<BackgroundStructuredObjectStreamSnapshot> = {},
): Promise<MeteredPartStream> {
  const {
    providerId,
    providerConfig,
    outputSchema: _outputSchema,
    usageFeature = "sharedRequests",
    ...streamParams
  } = serializablePayload
  const { signal, onError, dataCategories } = options

  // With a configuration the model and the call parameters come from that one configuration, as in
  // the text stream; looking the row up again would pair the stored row's model and endpoint with
  // parameters computed from the configuration the caller held. Without one (an older sender) the
  // provider is looked up by id.
  const model = providerConfig
    ? getLanguageModelForConfig(providerConfig, usageFeature, ...consentRuntimeArgs(dataCategories))
    : await getModelById(providerId, usageFeature, ...consentRuntimeArgs(dataCategories))
  const reporter = createApiUsageReporter(model, usageFeature)
  const result = streamText({
    ...(streamParams as Parameters<typeof streamText>[0]),
    ...(providerConfig ? buildLocalGenerateTextParams(providerConfig) : {}),
    model,
    output: Output.object({
      schema: objectSchema,
    }),
    abortSignal: signal,
    onFinish: ({ totalUsage }) => {
      reporter.observe(totalUsage)
    },
    onError: ({ error }) => {
      onError?.(error)
    },
  })

  return { stream: result.stream, reporter }
}

export async function runStructuredObjectStreamInBackground(
  serializablePayload: BackgroundStreamStructuredObjectSerializablePayload,
  options: StreamRuntimeOptions<BackgroundStructuredObjectStreamSnapshot> = {},
): Promise<BackgroundStructuredObjectStreamSnapshot> {
  const { signal, onChunk } = options

  if (signal?.aborted) {
    throw new DOMException("stream aborted", "AbortError")
  }

  const objectSchema = createStructuredObjectSchema(serializablePayload.outputSchema)
  const { stream: partStream, reporter } = await createLocalStructuredObjectPartStream(
    serializablePayload,
    objectSchema,
    options,
  )

  try {
    return await consumeStructuredObjectPartStream(partStream, { objectSchema, onChunk, signal })
  } finally {
    reporter.finish()
  }
}

export async function runNoteSuggestionStreamInBackground(
  serializablePayload: BackgroundStreamNoteSuggestionSerializablePayload,
  options: StreamRuntimeOptions<BackgroundNoteSuggestionStreamSnapshot> = {},
): Promise<BackgroundNoteSuggestionStreamSnapshot> {
  const { signal, onError, dataCategories } = options
  const { prompt, instructions } = serializablePayload

  if (signal?.aborted) {
    throw new DOMException("stream aborted", "AbortError")
  }

  if (!instructions || !prompt) {
    throw new BackgroundStreamError(
      "invalid_request",
      "Note suggestion requires instructions and prompt",
    )
  }

  // The note-suggestion port validates no configuration, so it keeps the provider-id lookup: drop
  // any `providerConfig` key a loose payload carries rather than build a model from unvalidated data.
  const { providerConfig: _unvalidatedConfig, ...noteSuggestionPayload } =
    serializablePayload as typeof serializablePayload & { providerConfig?: unknown }
  const { stream: partStream, reporter } = await createLocalStructuredObjectPartStream(
    { ...noteSuggestionPayload, usageFeature: "noteSuggestion" },
    noteSuggestionEnvelopeSchema,
    { signal, onError, dataCategories },
  )

  try {
    return await consumeStructuredObjectPartStream(partStream, {
      objectSchema: noteSuggestionEnvelopeSchema,
      signal,
    })
  } finally {
    reporter.finish()
  }
}

const parseStreamTextStartMessage =
  createStartMessageParser<BackgroundStreamTextSerializablePayload>(streamTextPayloadSchema)
const parseStructuredObjectStartMessage =
  createStartMessageParser<BackgroundStreamStructuredObjectSerializablePayload>(
    structuredObjectPayloadSchema,
  )
const parseNoteSuggestionStartMessage =
  createStartMessageParser<BackgroundStreamNoteSuggestionSerializablePayload>(
    baseStreamPayloadSchema,
  )

export const handleStreamTextPort = createStreamPortHandler<
  BackgroundStreamTextSerializablePayload,
  BackgroundTextStreamSnapshot
>(runStreamTextInBackground, parseStreamTextStartMessage)

export const handleStreamStructuredObjectPort = createStreamPortHandler<
  BackgroundStreamStructuredObjectSerializablePayload,
  BackgroundStructuredObjectStreamSnapshot
>(runStructuredObjectStreamInBackground, parseStructuredObjectStartMessage)

export const handleStreamNoteSuggestionPort = createStreamPortHandler<
  BackgroundStreamNoteSuggestionSerializablePayload,
  BackgroundNoteSuggestionStreamSnapshot
>(runNoteSuggestionStreamInBackground, parseNoteSuggestionStartMessage)

export const BACKGROUND_STREAM_PORT_HANDLERS: Readonly<
  Record<BackgroundStreamPortName, StreamPortHandler>
> = {
  [BACKGROUND_STREAM_PORTS.streamText]: handleStreamTextPort,
  [BACKGROUND_STREAM_PORTS.streamStructuredObject]: handleStreamStructuredObjectPort,
  [BACKGROUND_STREAM_PORTS.streamNoteSuggestion]: handleStreamNoteSuggestionPort,
}

export function dispatchBackgroundStreamPort(port: Browser.runtime.Port): boolean {
  const handler = BACKGROUND_STREAM_PORT_HANDLERS[port.name as BackgroundStreamPortName]
  if (!handler) {
    return false
  }

  handler(port)
  return true
}
