import type { JSONValue, StreamTextOnErrorCallback } from "ai"
import type { Browser } from "#imports"
import type { AnalyticsFailureReason } from "@/types/analytics"
import type { AISDKReasoning, LLMProviderConfig } from "@/types/config/provider"
import type { SelectionToolbarCustomActionOutputType } from "@/types/config/selection-toolbar"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { ErrorAction } from "@/utils/error-action"
import type { NoteSuggestionEnvelope } from "@/utils/note-suggestion/types"

interface BaseBackgroundStreamSerializablePayload {
  usageFeature?: ApiUsageFeature
  providerId: string
  instructions?: string
  prompt?: string
  messages?: JSONValue[]
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stopSequences?: string[]
  reasoning?: AISDKReasoning
  providerOptions?: Record<string, Record<string, JSONValue>>
}

export type BackgroundStreamTextSerializablePayload = BaseBackgroundStreamSerializablePayload & {
  providerKind: "local"
  /** Configuration snapshot used for both cache identity and model creation. */
  providerConfig?: LLMProviderConfig
}

export interface BackgroundStructuredObjectOutputField {
  name: string
  type: SelectionToolbarCustomActionOutputType
}

export interface ThinkingSnapshot {
  status: "thinking" | "complete"
  text: string
}

export interface BackgroundStreamSnapshot<TOutput> {
  output: TOutput
  thinking: ThinkingSnapshot
}

export type BackgroundTextStreamSnapshot = BackgroundStreamSnapshot<string>

export type BackgroundStructuredObjectStreamSnapshot = BackgroundStreamSnapshot<
  Record<string, unknown>
>

export type BackgroundStreamStructuredObjectSerializablePayload =
  BaseBackgroundStreamSerializablePayload & {
    outputSchema: BackgroundStructuredObjectOutputField[]
    /**
     * The configuration the caller built this request from. The model and every call parameter come
     * from it, so a row edited after the caller captured it cannot be mixed in. Without it (an older
     * sender) the background looks the provider up by `providerId`.
     */
    providerConfig?: LLMProviderConfig
  }

export type BackgroundStreamNoteSuggestionSerializablePayload =
  BaseBackgroundStreamSerializablePayload

export type BackgroundNoteSuggestionStreamSnapshot =
  BackgroundStreamSnapshot<NoteSuggestionEnvelope>

export const BACKGROUND_STREAM_PORTS = {
  streamText: "stream-text",
  streamStructuredObject: "stream-structured-object",
  streamNoteSuggestion: "stream-note-suggestion",
} as const

export type BackgroundStreamChannel = keyof typeof BACKGROUND_STREAM_PORTS
export type BackgroundStreamPortName = (typeof BACKGROUND_STREAM_PORTS)[BackgroundStreamChannel]

export interface BackgroundStreamResponseMap {
  streamText: BackgroundTextStreamSnapshot
  streamStructuredObject: BackgroundStructuredObjectStreamSnapshot
  streamNoteSuggestion: BackgroundNoteSuggestionStreamSnapshot
}

export interface StreamPortErrorPayload {
  message: string
  /** What the user can do about it, when the background knows. */
  action?: ErrorAction
  /** Classified where the original error still exists, for failure analytics. */
  reason?: AnalyticsFailureReason
}

export type StreamPortResponse<T = string> =
  | { type: "chunk"; streamRequestId: string; data: T }
  | { type: "done"; streamRequestId: string; data: T }
  | { type: "error"; streamRequestId: string; error: StreamPortErrorPayload }

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never

export type StreamPortResponseWithoutStreamRequestId<T = string> = DistributiveOmit<
  StreamPortResponse<T>,
  "streamRequestId"
>

export interface StreamPortStartMessage<TSerializablePayload> {
  type: "start"
  streamRequestId: string
  payload: TSerializablePayload
}

export interface StreamPortPingMessage {
  type: "ping"
  streamRequestId: string
}

export type StreamPortRequestMessage<TSerializablePayload> =
  | StreamPortStartMessage<TSerializablePayload>
  | { type: "ping"; streamRequestId: string }

export type StartMessageParseResult<TSerializablePayload> =
  | { success: true; message: StreamPortStartMessage<TSerializablePayload> }
  | { success: false; streamRequestId?: string }

type AISDKStreamTextError = Parameters<StreamTextOnErrorCallback>[0]["error"]

export interface StreamRuntimeOptions<TResponse = unknown> {
  signal?: AbortSignal
  onChunk?: (snapshot: TResponse) => void
  onError?: (error: AISDKStreamTextError) => void
}

export type StreamPortHandler = (port: Browser.runtime.Port) => void
