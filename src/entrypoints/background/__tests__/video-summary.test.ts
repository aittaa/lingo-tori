import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn<(...args: any[]) => any>(),
  get: vi.fn<(key: string) => Promise<{ summary: string } | undefined>>(),
  put: vi.fn<(record: { key: string; summary: string; createdAt: Date }) => Promise<void>>(),
}))

vi.mock("@/utils/message", () => ({ onMessage: mocks.onMessage }))
vi.mock("@/utils/db/dexie/db", () => ({
  db: { articleSummaryCache: { get: mocks.get, put: mocks.put } },
}))

// These cache handlers must work independently of queue and model initialization.
vi.mock("../translation-queues", () => {
  throw new Error("Video summary cache handlers must not depend on translation queues")
})
vi.mock("../background-stream", () => {
  throw new Error("Video summary cache handlers must not initialize generation")
})

const providerRef: PromptableProviderRef = {
  kind: "local",
  config: {
    id: "test-openai",
    name: "Test OpenAI",
    enabled: true,
    provider: "openai",
    apiKey: "test-key",
    model: { model: "gpt-4o-mini", isCustomModel: false, customModel: null },
  },
}
const request = { transcript: "Video transcript", targetLanguage: "English", providerRef }

function handler(name: string) {
  const registration = mocks.onMessage.mock.calls.find(
    ([registeredName]) => registeredName === name,
  )
  if (!registration) throw new Error(`Missing handler: ${name}`)
  return registration[1] as (message: {
    data: typeof request & { summary?: string }
  }) => Promise<unknown>
}

describe("video summary cache handlers", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.get.mockResolvedValue(undefined)
    mocks.put.mockResolvedValue(undefined)
  })

  it("registers both cache handlers synchronously without translation queues", async () => {
    const { setupVideoSummaryHandlers } = await import("../video-summary")
    setupVideoSummaryHandlers()

    expect(mocks.onMessage.mock.calls.map(([name]) => name)).toEqual([
      "getCachedVideoSummary",
      "saveVideoSummary",
    ])
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it("reads entries written under the existing video summary cache key", async () => {
    // Frozen key for this configured local provider fixture.
    const existingKey = "ff47f70ddfb1e37b65f35352356e6a1d8ba7fb0a79a097a3ea2d4a1d3a169b08"
    mocks.get.mockImplementation(async (key) =>
      key === existingKey ? { summary: "Existing summary" } : undefined,
    )
    const { setupVideoSummaryHandlers } = await import("../video-summary")
    setupVideoSummaryHandlers()

    await expect(handler("getCachedVideoSummary")({ data: request })).resolves.toBe(
      "Existing summary",
    )
    expect(mocks.get).toHaveBeenCalledWith(existingKey)
  })

  it("saves trimmed summaries under the same key used to read them", async () => {
    const { setupVideoSummaryHandlers } = await import("../video-summary")
    setupVideoSummaryHandlers()
    await handler("getCachedVideoSummary")({ data: request })
    await handler("saveVideoSummary")({ data: { ...request, summary: "  Finished summary\n" } })

    expect(mocks.put).toHaveBeenCalledExactlyOnceWith({
      key: mocks.get.mock.calls[0]![0],
      summary: "Finished summary",
      createdAt: expect.any(Date),
    })
  })

  it.each([
    { transcript: "", summary: "Summary" },
    { transcript: "Video transcript", summary: " \n " },
  ])("does not persist an empty transcript or summary", async (overrides) => {
    const { setupVideoSummaryHandlers } = await import("../video-summary")
    setupVideoSummaryHandlers()
    await handler("saveVideoSummary")({ data: { ...request, ...overrides } })
    expect(mocks.put).not.toHaveBeenCalled()
  })
})
