import type { ProviderRequestRouting } from "./hosted-request"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"

export type BackgroundGenerateTextPayload = ProviderRequestRouting<PromptableProviderRef> & {
  instructions: string
  prompt: string
  /** Retry count for this call; queues normally manage retries. */
  maxRetries?: number
}

export interface BackgroundGenerateTextResponse {
  text: string
}
