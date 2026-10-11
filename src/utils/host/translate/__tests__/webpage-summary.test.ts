// @vitest-environment jsdom

import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

const localRef: PromptableProviderRef = {
  kind: "local",
  config: {
    id: "openai-default",
    name: "OpenAI",
    provider: "openai",
    enabled: true,
    apiKey: "sk-test",
    model: { model: "gpt-5-mini", isCustomModel: false, customModel: null },
  } as never,
}

const webPageContext = {
  url: "https://example.com/article",
  webTitle: "Page title",
  webContent: "Page body",
}

describe("getOrGenerateWebPageSummary", () => {
  it("requests webpage summary through a dedicated background message", async () => {
    const { sendMessage } = await import("@/utils/message")
    vi.mocked(sendMessage).mockResolvedValue("Generated summary")

    const { getOrGenerateWebPageSummary } = await import("../webpage-summary")
    const result = await getOrGenerateWebPageSummary(webPageContext, localRef, true)

    expect(result).toBe("Generated summary")
    expect(sendMessage).toHaveBeenCalledWith("getOrGenerateWebPageSummary", {
      webTitle: "Page title",
      webContent: "Page body",
      providerRef: localRef,
    })
  })

  it("skips the round trip when AI content awareness is off or context is empty", async () => {
    const { sendMessage } = await import("@/utils/message")
    vi.mocked(sendMessage).mockClear()

    const { getOrGenerateWebPageSummary } = await import("../webpage-summary")
    await expect(getOrGenerateWebPageSummary(webPageContext, localRef, false)).resolves.toBeNull()
    await expect(getOrGenerateWebPageSummary(null, localRef, true)).resolves.toBeNull()
    await expect(
      getOrGenerateWebPageSummary({ ...webPageContext, webContent: "  " }, localRef, true),
    ).resolves.toBeNull()

    expect(sendMessage).not.toHaveBeenCalled()
  })
})
