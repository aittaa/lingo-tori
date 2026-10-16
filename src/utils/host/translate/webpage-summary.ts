import type { CachedWebPageContext } from "./webpage-context"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { sendMessage } from "@/utils/message"

export async function getOrGenerateWebPageSummary(
  webPageContext: CachedWebPageContext | null,
  providerRef: PromptableProviderRef,
  enableAIContentAware: boolean,
  // The page-translation session the summary is for. Left out, the summary belongs to no session.
  sessionId?: string,
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
    ...(sessionId === undefined ? {} : { sessionId }),
  })

  return summary || null
}
