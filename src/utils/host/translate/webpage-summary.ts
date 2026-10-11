import type { CachedWebPageContext } from "./webpage-context"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { sendMessage } from "@/utils/message"

export async function getOrGenerateWebPageSummary(
  webPageContext: CachedWebPageContext | null,
  providerRef: PromptableProviderRef,
  enableAIContentAware: boolean,
): Promise<string | null> {
  if (!enableAIContentAware || !webPageContext) {
    return null
  }

  const { webTitle, webContent } = webPageContext
  if (!webTitle.trim() || !webContent.trim()) {
    return null
  }

  const summary = await sendMessage("getOrGenerateWebPageSummary", {
    webTitle,
    webContent,
    providerRef,
  })

  return summary || null
}
