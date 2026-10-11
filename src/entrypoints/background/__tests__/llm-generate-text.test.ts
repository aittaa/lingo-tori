import { beforeEach, describe, expect, it, vi } from "vitest"

const onMessageMock = vi.fn<(...args: any[]) => any>()
const generateTextForProviderRefMock = vi.fn<(...args: any[]) => any>()
const loggerErrorMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: onMessageMock,
}))

// Model selection and tuning details live in
// background-stream's generateTextForProviderRef; this module is only the
// message adapter over it, so that is the boundary worth mocking.
vi.mock("../background-stream", () => ({
  generateTextForProviderRef: generateTextForProviderRefMock,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: loggerErrorMock,
  },
}))

const localPayload = {
  providerRef: { kind: "local" as const, config: { id: "openai-default" } as never },
  instructions: "system",
  prompt: "hello world",
}

function getRegisteredMessageHandler(name: string) {
  const registration = onMessageMock.mock.calls.find((call) => call[0] === name)
  if (!registration) {
    throw new Error(`Message handler not registered: ${name}`)
  }
  return registration[1] as (message: {
    data: Record<string, unknown>
  }) => Promise<{ text: string }>
}

describe("llm-generate-text", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it("returns the generated text for the given provider ref", async () => {
    generateTextForProviderRefMock.mockResolvedValue("eng")

    const { runGenerateTextInBackground } = await import("../llm-generate-text")
    const result = await runGenerateTextInBackground(localPayload)

    expect(generateTextForProviderRefMock).toHaveBeenCalledWith(localPayload)
    expect(result).toEqual({ text: "eng" })
  })

  it("logs and rethrows handler errors", async () => {
    generateTextForProviderRefMock.mockRejectedValue(new Error("provider unavailable"))

    const { setupLLMGenerateTextMessageHandlers } = await import("../llm-generate-text")
    setupLLMGenerateTextMessageHandlers()
    const handler = getRegisteredMessageHandler("backgroundGenerateText")

    await expect(handler({ data: localPayload })).rejects.toThrow("provider unavailable")
    expect(loggerErrorMock).toHaveBeenCalled()
  })

  it.each([
    undefined,
    null,
    { kind: "system", providerId: "retired-hosted-provider" },
    { kind: "local" },
  ])("rejects an unconfigured provider reference (%s)", async (providerRef) => {
    const { setupLLMGenerateTextMessageHandlers } = await import("../llm-generate-text")
    setupLLMGenerateTextMessageHandlers()
    const handler = getRegisteredMessageHandler("backgroundGenerateText")
    await expect(handler({ data: { ...localPayload, providerRef } })).rejects.toThrow(
      "A configured local provider is required",
    )
    expect(generateTextForProviderRefMock).not.toHaveBeenCalled()
  })

  it("allows local generation without extra routing metadata", async () => {
    const payload = localPayload
    generateTextForProviderRefMock.mockResolvedValue("local text")
    const { runGenerateTextInBackground } = await import("../llm-generate-text")
    await expect(runGenerateTextInBackground(payload)).resolves.toEqual({ text: "local text" })
  })
})
