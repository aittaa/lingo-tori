import type {
  BackgroundGenerateTextPayload,
  BackgroundGenerateTextResponse,
} from "@/types/background-generate-text"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { generateTextForProviderRef } from "./background-stream"

export async function runGenerateTextInBackground(
  payload: BackgroundGenerateTextPayload,
): Promise<BackgroundGenerateTextResponse> {
  if (payload.providerRef?.kind !== "local" || !payload.providerRef.config) {
    throw new Error("A configured local provider is required")
  }
  return { text: await generateTextForProviderRef(payload, { usageFeature: "languageDetection" }) }
}

export function setupLLMGenerateTextMessageHandlers() {
  onMessage("backgroundGenerateText", async (message) => {
    try {
      return await runGenerateTextInBackground(message.data)
    } catch (error) {
      logger.error("[Background] backgroundGenerateText failed", error)
      throw error
    }
  })
}
