import type { BackgroundStructuredObjectStreamSnapshot } from "@/types/background-stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { ProviderSetupError } from "@/utils/providers/provider-setup-error"

const streamTextMock = vi.fn<(...args: any[]) => any>()
const outputObjectMock = vi.fn<(...args: any[]) => any>((params: Record<string, unknown>) => params)
const getModelByIdMock = vi.fn<(...args: any[]) => any>()
const getLanguageModelForConfigMock = vi.fn<(...args: any[]) => any>()
const loggerErrorMock = vi.fn<(...args: any[]) => any>()
const parsePartialJsonMock = vi.fn<(...args: any[]) => any>(async (text: string | undefined) => {
  if (!text) {
    return { state: "undefined-input", value: undefined }
  }

  try {
    return { state: "successful-parse", value: JSON.parse(text) }
  } catch {
    try {
      return { state: "repaired-parse", value: JSON.parse(`${text}}`) }
    } catch {
      return { state: "failed-parse", value: undefined }
    }
  }
})

class MockNoOutputGeneratedError extends Error {
  static isInstance(error: unknown): error is MockNoOutputGeneratedError {
    return error instanceof MockNoOutputGeneratedError
  }
}

vi.mock("ai", () => ({
  streamText: streamTextMock,
  parsePartialJson: parsePartialJsonMock,
  NoOutputGeneratedError: MockNoOutputGeneratedError,
  Output: {
    object: outputObjectMock,
  },
}))

vi.mock("@/utils/providers/model", () => ({
  getModelById: getModelByIdMock,
  getLanguageModelForConfig: getLanguageModelForConfigMock,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: loggerErrorMock,
  },
}))

function createMockPort(name: string) {
  let messageListener: ((message: unknown) => void | Promise<void>) | undefined
  let disconnectListener: (() => void) | undefined

  const postMessage = vi.fn<(...args: any[]) => any>()
  const disconnect = vi.fn<(...args: any[]) => any>()

  const port = {
    name,
    postMessage,
    disconnect,
    onMessage: {
      addListener: vi.fn<(...args: any[]) => any>(
        (listener: (message: unknown) => void | Promise<void>) => {
          messageListener = listener
        },
      ),
      removeListener: vi.fn<(...args: any[]) => any>(
        (listener: (message: unknown) => void | Promise<void>) => {
          if (messageListener === listener) {
            messageListener = undefined
          }
        },
      ),
    },
    onDisconnect: {
      addListener: vi.fn<(...args: any[]) => any>((listener: () => void) => {
        disconnectListener = listener
      }),
      removeListener: vi.fn<(...args: any[]) => any>((listener: () => void) => {
        if (disconnectListener === listener) {
          disconnectListener = undefined
        }
      }),
    },
  }

  return {
    port,
    postMessage,
    disconnect,
    async emitMessage(message: unknown) {
      if (!messageListener) {
        throw new Error("Port message listener is not registered")
      }
      await messageListener(message)
    },
    emitDisconnect() {
      disconnectListener?.()
    },
  }
}

describe("background-stream", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it.each([undefined, null, "", "unknownFeature", "toString"])(
    "rejects an invalid hosted feature (%s) at the stream port before calling a provider",
    async (hostedFeature) => {
      const { handleStreamTextPort } = await import("../background-stream")
      const mockPort = createMockPort("stream-text")
      handleStreamTextPort(mockPort.port as never)
      await mockPort.emitMessage({
        type: "start",
        streamRequestId: "invalid-hosted-route",
        payload: {
          providerKind: "system",
          providerId: "read-frog-free-ai",
          hostedFeature,
          instructions: "Translate",
          prompt: "Hello",
        },
      })
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: "error",
        streamRequestId: "invalid-hosted-route",
        error: { message: "Invalid stream start payload" },
      })
      expect(getModelByIdMock).not.toHaveBeenCalled()
      expect(streamTextMock).not.toHaveBeenCalled()
    },
  )

  it("streams structured object output from background", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: '{"score":97' }
        yield { type: "text-delta", text: ',"summary":"Strong argument structure"}' }
        yield { type: "finish", finishReason: "stop" }
      })(),
      get output() {
        throw new Error("structured stream should not consume output separately")
      },
      get partialOutputStream() {
        throw new Error("structured stream should not consume partialOutputStream separately")
      },
    })

    const chunkSnapshots: BackgroundStructuredObjectStreamSnapshot[] = []
    const { runStructuredObjectStreamInBackground } = await import("../background-stream")
    const result = await runStructuredObjectStreamInBackground(
      {
        providerId: "openai-default",
        prompt: "Analyze selection",
        outputSchema: [
          { name: "score", type: "number" },
          { name: "summary", type: "string" },
        ],
      },
      {
        onChunk: (snapshot) => {
          chunkSnapshots.push(snapshot)
        },
      },
    )

    expect(getModelByIdMock).toHaveBeenCalledWith("openai-default")
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mock-model",
        prompt: "Analyze selection",
      }),
    )
    expect(result).toEqual({
      output: {
        score: 97,
        summary: "Strong argument structure",
      },
      thinking: {
        status: "complete",
        text: "",
      },
    })
    expect(chunkSnapshots).toEqual([
      {
        output: { score: 97 },
        thinking: {
          status: "complete",
          text: "",
        },
      },
      {
        output: { score: 97, summary: "Strong argument structure" },
        thinking: {
          status: "complete",
          text: "",
        },
      },
    ])

    const schemaArg = outputObjectMock.mock.calls[0]![0].schema as {
      safeParse: (value: unknown) => { success: boolean }
    }
    expect(
      schemaArg.safeParse({
        score: 99,
        summary: "text",
      }).success,
    ).toBe(true)
    expect(
      schemaArg.safeParse({
        score: null,
        summary: null,
      }).success,
    ).toBe(true)
    expect(
      schemaArg.safeParse({
        score: "99",
        summary: "text",
      }).success,
    ).toBe(false)
  })

  it("treats structured object streams without finish as protocol errors", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: '{"score":97}' }
      })(),
    })

    const { runStructuredObjectStreamInBackground } = await import("../background-stream")

    await expect(
      runStructuredObjectStreamInBackground({
        providerId: "openai-default",
        prompt: "Analyze selection",
        outputSchema: [{ name: "score", type: "number" }],
      }),
    ).rejects.toThrow("Invalid AI stream response.")
  })

  it("treats length-finished structured object streams as truncated output", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: '{"summary":"partial but parseable' }
        yield { type: "finish", finishReason: "length" }
      })(),
    })

    const { runStructuredObjectStreamInBackground } = await import("../background-stream")

    await expect(
      runStructuredObjectStreamInBackground({
        providerId: "openai-default",
        prompt: "Analyze selection",
        outputSchema: [{ name: "summary", type: "string" }],
      }),
    ).rejects.toThrow(
      "The AI output reached the length limit. Please reduce the requested output length and try again.",
    )
  })

  it("treats text streams without finish as protocol errors", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: "Hello" }
      })(),
    })

    const { runStreamTextInBackground } = await import("../background-stream")

    await expect(
      runStreamTextInBackground({
        providerKind: "local",
        providerId: "openai-default",
        prompt: "Say hello",
      }),
    ).rejects.toThrow("Invalid AI stream response.")
  })

  it("treats length-finished text streams as truncated output", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: "partial" }
        yield { type: "finish", finishReason: "length" }
      })(),
    })

    const { runStreamTextInBackground } = await import("../background-stream")

    await expect(
      runStreamTextInBackground({
        providerKind: "local",
        providerId: "openai-default",
        prompt: "Say hello",
      }),
    ).rejects.toThrow(
      "The AI output reached the length limit. Please reduce the requested output length and try again.",
    )
  })

  it("streams text via background stream port handler", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: "Hello" }
        yield { type: "text-delta", text: " world" }
        yield { type: "finish", finishReason: "stop" }
      })(),
      output: Promise.resolve("Hello world"),
    })

    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "start",
      streamRequestId: "req-text-1",
      payload: {
        providerKind: "local",
        providerId: "openai-default",
        instructions: "Be concise",
        prompt: "Say hello",
        reasoning: "low",
      },
    })

    expect(getModelByIdMock).toHaveBeenCalledWith("openai-default")
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "Be concise",
        reasoning: "low",
      }),
    )
    expect(mockPort.postMessage).toHaveBeenNthCalledWith(1, {
      type: "chunk",
      streamRequestId: "req-text-1",
      data: {
        output: "Hello",
        thinking: {
          status: "complete",
          text: "",
        },
      },
    })
    expect(mockPort.postMessage).toHaveBeenNthCalledWith(2, {
      type: "chunk",
      streamRequestId: "req-text-1",
      data: {
        output: "Hello world",
        thinking: {
          status: "complete",
          text: "",
        },
      },
    })
    expect(mockPort.postMessage).toHaveBeenNthCalledWith(3, {
      type: "done",
      streamRequestId: "req-text-1",
      data: {
        output: "Hello world",
        thinking: {
          status: "complete",
          text: "",
        },
      },
    })
    expect(mockPort.disconnect).toHaveBeenCalledTimes(1)
  })

  it("uses the supplied local snapshot for both the model and its generation settings", async () => {
    const providerConfig = {
      ...DEFAULT_PROVIDER_CONFIG.openai,
      temperature: 0.3,
      reasoning: "low" as const,
    }
    // Storage may now contain another model, or the provider may have been deleted.
    getModelByIdMock.mockRejectedValue(new Error("Provider deleted"))
    getLanguageModelForConfigMock.mockReturnValue("snapshot-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: "Snapshot summary" }
        yield { type: "finish", finishReason: "stop" }
      })(),
    })
    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")
    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "start",
      streamRequestId: "summary-snapshot",
      payload: {
        providerKind: "local",
        providerId: providerConfig.id,
        providerConfig,
        instructions: "Summarize",
        prompt: "Video contents",
        temperature: 0.9,
        reasoning: "high",
      },
    })

    expect(getModelByIdMock).not.toHaveBeenCalled()
    expect(getLanguageModelForConfigMock).toHaveBeenCalledWith(providerConfig)
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "snapshot-model",
        temperature: 0.3,
        reasoning: "low",
      }),
    )
    expect(streamTextMock.mock.calls[0]![0]).not.toHaveProperty("providerConfig")
    expect(mockPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        data: expect.objectContaining({ output: "Snapshot summary" }),
      }),
    )
  })

  it.each([
    {
      providerKind: "local",
      providerId: "other-id",
      providerConfig: DEFAULT_PROVIDER_CONFIG.openai,
    },
    {
      providerKind: "local",
      providerId: DEFAULT_PROVIDER_CONFIG["deepl"].id,
      providerConfig: DEFAULT_PROVIDER_CONFIG["deepl"],
    },
    {
      providerKind: "system",
      hostedFeature: "pageTranslation",
      providerId: "read-frog-free-ai",
      providerConfig: { ...DEFAULT_PROVIDER_CONFIG.openai, id: "read-frog-free-ai" },
    },
  ])("rejects invalid local snapshots before starting a stream", async (payload) => {
    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")
    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({ type: "start", streamRequestId: "invalid-snapshot", payload })

    expect(streamTextMock).not.toHaveBeenCalled()
    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: "error",
      streamRequestId: "invalid-snapshot",
      error: { message: "Invalid stream start payload" },
    })
  })

  it("prefers stream onError root cause and posts error once", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    const rootCause = Object.assign(new Error("Incorrect API key provided"), {
      responseBody: '{"error":{"message":"Incorrect API key provided"}}',
    })

    streamTextMock.mockImplementation(
      (options: { onError?: (event: { error: unknown }) => void }) => {
        options.onError?.({ error: rootCause })
        return {
          stream: (async function* () {})(),
          get output() {
            throw new Error("text stream should not consume output separately")
          },
        }
      },
    )

    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "start",
      streamRequestId: "req-text-error",
      payload: {
        providerKind: "local",
        providerId: "openai-default",
        prompt: "Say hello",
      },
    })

    const errorMessages = mockPort.postMessage.mock.calls
      .map((call) => call[0] as { type: string; error?: unknown })
      .filter((message) => message.type === "error")

    expect(errorMessages).toHaveLength(1)
    expect(errorMessages[0]).toMatchObject({
      type: "error",
      streamRequestId: "req-text-error",
      error: {
        message: "Incorrect API key provided",
      },
    })
    expect(mockPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "done" }))
  })

  it("keeps outer catch as fallback for pre-stream errors", async () => {
    getModelByIdMock.mockRejectedValue(new ProviderSetupError("Model is undefined"))
    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "start",
      streamRequestId: "req-text-pre-stream-error",
      payload: {
        providerKind: "local",
        providerId: "openai-default",
        prompt: "Say hello",
      },
    })

    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: "error",
      streamRequestId: "req-text-pre-stream-error",
      error: {
        message: "Model is undefined",
        reason: "precheck",
      },
    })
    expect(mockPort.disconnect).toHaveBeenCalledTimes(1)
  })

  it("treats stream port disconnect aborts as expected cancellation", async () => {
    getModelByIdMock.mockResolvedValue("mock-model")
    let streamSignal: AbortSignal | undefined

    streamTextMock.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      streamSignal = options.abortSignal
      return {
        stream: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await new Promise<void>((_resolve, reject) => {
                  options.abortSignal?.addEventListener("abort", () => {
                    reject(options.abortSignal?.reason ?? new DOMException("aborted", "AbortError"))
                  })
                })
                return { done: true, value: undefined }
              },
            }
          },
        },
        output: new Promise<string>(() => {}),
      }
    })

    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    const startPromise = mockPort.emitMessage({
      type: "start",
      streamRequestId: "req-text-abort",
      payload: {
        providerKind: "local",
        providerId: "openai-default",
        prompt: "Say hello",
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(streamTextMock).toHaveBeenCalledTimes(1)

    mockPort.emitDisconnect()
    await startPromise

    expect(streamSignal?.aborted).toBe(true)
    expect(loggerErrorMock).not.toHaveBeenCalled()
    expect(mockPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
      }),
    )
  })

  it("returns error for invalid text start payload and disconnects", async () => {
    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "start",
      streamRequestId: "req-text-invalid",
      payload: {
        providerKind: "local",
        providerId: "   ",
      },
    })

    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: "error",
      streamRequestId: "req-text-invalid",
      error: { message: "Invalid stream start payload" },
    })
    expect(mockPort.disconnect).toHaveBeenCalledTimes(1)
    expect(getModelByIdMock).not.toHaveBeenCalled()
  })

  it("returns error for invalid structured payload and disconnects", async () => {
    const { handleStreamStructuredObjectPort } = await import("../background-stream")

    const emptySchemaPort = createMockPort("stream-structured-object")
    handleStreamStructuredObjectPort(emptySchemaPort.port as never)
    await emptySchemaPort.emitMessage({
      type: "start",
      streamRequestId: "req-structured-empty",
      payload: {
        providerId: "openai-default",
        outputSchema: [],
      },
    })

    expect(emptySchemaPort.postMessage).toHaveBeenCalledWith({
      type: "error",
      streamRequestId: "req-structured-empty",
      error: { message: "Invalid stream start payload" },
    })
    expect(emptySchemaPort.disconnect).toHaveBeenCalledTimes(1)

    const duplicateKeyPort = createMockPort("stream-structured-object")
    handleStreamStructuredObjectPort(duplicateKeyPort.port as never)
    await duplicateKeyPort.emitMessage({
      type: "start",
      streamRequestId: "req-structured-duplicate",
      payload: {
        providerId: "openai-default",
        outputSchema: [
          { name: "score ", type: "number" },
          { name: "score", type: "string" },
        ],
      },
    })

    expect(duplicateKeyPort.postMessage).toHaveBeenCalledWith({
      type: "error",
      streamRequestId: "req-structured-duplicate",
      error: { message: "Invalid stream start payload" },
    })
    expect(duplicateKeyPort.disconnect).toHaveBeenCalledTimes(1)
  })

  it("disconnects invalid start message without streamRequestId and cannot post error", async () => {
    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "start",
      payload: {
        providerKind: "local",
        providerId: "openai-default",
      },
    })

    expect(mockPort.postMessage).not.toHaveBeenCalled()
    expect(mockPort.disconnect).toHaveBeenCalledTimes(1)
  })

  it("ignores ping messages before stream starts", async () => {
    const { handleStreamTextPort } = await import("../background-stream")
    const mockPort = createMockPort("stream-text")

    handleStreamTextPort(mockPort.port as never)
    await mockPort.emitMessage({
      type: "ping",
      streamRequestId: "req-ping",
    })

    expect(mockPort.postMessage).not.toHaveBeenCalled()
    expect(mockPort.disconnect).not.toHaveBeenCalled()
  })

  it("streams note suggestions from the user's local provider", async () => {
    const envelope = {
      summaryFieldName: null,
      notes: [{ fields: [{ name: "Word", value: "ephemeral" }] }],
    }
    getModelByIdMock.mockResolvedValue("mock-model")
    streamTextMock.mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", text: JSON.stringify(envelope) }
        yield { type: "finish", finishReason: "stop" }
      })(),
    })

    const { runNoteSuggestionStreamInBackground } = await import("../background-stream")
    const { noteSuggestionEnvelopeSchema } = await import("@/utils/note-suggestion/types")
    const result = await runNoteSuggestionStreamInBackground({
      providerId: "openai-default",
      instructions: "Suggest words",
      prompt: "Selection context",
    })

    expect(getModelByIdMock).toHaveBeenCalledWith("openai-default")
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mock-model",
        instructions: "Suggest words",
        prompt: "Selection context",
      }),
    )
    expect(outputObjectMock).toHaveBeenCalledWith({ schema: noteSuggestionEnvelopeSchema })
    expect(result).toEqual({
      output: envelope,
      thinking: { status: "complete", text: "" },
    })
  })

  it("propagates provider resolution failures for note suggestions", async () => {
    getModelByIdMock.mockRejectedValue(new Error("Provider missing-provider not found"))

    const { runNoteSuggestionStreamInBackground } = await import("../background-stream")

    await expect(
      runNoteSuggestionStreamInBackground({
        providerId: "missing-provider",
        instructions: "Suggest words",
        prompt: "Selection context",
      }),
    ).rejects.toThrow("Provider missing-provider not found")
    expect(streamTextMock).not.toHaveBeenCalled()
  })
})
