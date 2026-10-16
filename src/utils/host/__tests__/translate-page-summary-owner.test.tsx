// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

/**
 * A page paragraph that wants the smart-context summary, from `translateTextForPage` to the
 * provider.
 *
 * Real: `translateTextForPage` and the translate core, the content-side summary request, the
 * background `getOrGenerateWebPageSummary` / `enqueueTranslateRequest` / `cancelPageTranslationRequests`
 * handlers, the real RequestQueue and BatchQueue, and the page translation session. Replaced: the
 * message transport (a bus handing a content message to the registered handler), the stored config,
 * the page text reader, the caches, and the provider edge (`generateTextForProviderRef` for the
 * summary and `executeTranslate` for the paragraph, both counted).
 *
 * Stopping is what `PageTranslationManager.stopInternal` does to the requests: end the session, then
 * send `cancelPageTranslationRequests` for it. The manager itself is not driven here (synthetic).
 */

const bus = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => Promise<unknown>>(),
  sent: [] as Array<{ type: string; data: Record<string, unknown> }>,
  sender: { tab: { id: 1 } },
}))
const getLocalConfigMock = vi.fn<(...args: any[]) => any>()
const ensureInitializedConfigMock = vi.fn<(...args: any[]) => any>()
const getOrCreateWebPageContextMock = vi.fn<(...args: any[]) => any>()
const generateTextMock = vi.fn<(...args: any[]) => any>()
const executeTranslateMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: (type: string, handler: (message: unknown) => Promise<unknown>) => {
    bus.handlers.set(type, handler)
  },
  sendMessage: async (type: string, data: Record<string, unknown>) => {
    bus.sent.push({ type, data: structuredClone(data) })
    const handler = bus.handlers.get(type)
    if (!handler) throw new Error(`No handler registered for '${type}'`)
    return handler({ type, data: structuredClone(data), sender: bus.sender })
  },
}))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: getLocalConfigMock }))
vi.mock("@/utils/prompts/translate", () => ({
  getTranslatePrompt: vi
    .fn<(...args: any[]) => any>()
    .mockResolvedValue({ systemPrompt: "system", prompt: "prompt" }),
  getTranslatePromptTemplate: vi
    .fn<(...args: any[]) => any>()
    .mockResolvedValue({ systemPrompt: "system", prompt: "{{input}}" }),
}))
vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: getOrCreateWebPageContextMock,
}))
vi.mock("@/entrypoints/background/config", () => ({
  ensureInitializedConfig: ensureInitializedConfigMock,
}))
vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: executeTranslateMock,
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    articleSummaryCache: {
      get: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      put: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    },
    translationCache: {
      delete: vi.fn<() => undefined>(),
      get: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      put: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    },
  },
}))
vi.mock("@/entrypoints/background/background-stream", () => ({
  runStreamTextInBackground: vi.fn<() => undefined>(),
  generateTextForProviderRef: generateTextMock,
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface SummaryCall {
  signal: AbortSignal | undefined
}
let summaryCalls: SummaryCall[]
let paragraphCalls: string[]

const WEB_CONTEXT = {
  url: "https://example.com/article",
  webTitle: "Page title",
  webContent: "Page body that is long enough to be summarised.",
}

function configWith(enableAIContentAware: boolean) {
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
    pageTranslation: {
      ...DEFAULT_CONFIG.pageTranslation,
      providerId: "openai-default",
      enableAIContentAware,
    },
  }
}

/** A provider that finishes when told to, and gives up when its request is aborted. */
function heldSummary() {
  const held = createDeferred<string>()
  generateTextMock.mockImplementation((_payload: unknown, options?: any) => {
    summaryCalls.push({ signal: options?.signal })
    return new Promise<string>((resolve, reject) => {
      held.promise.then(resolve, reject)
      options?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      )
    })
  })
  return held
}

async function setup(enableAIContentAware = true) {
  getLocalConfigMock.mockResolvedValue(configWith(enableAIContentAware))
  ensureInitializedConfigMock.mockResolvedValue({
    ...configWith(enableAIContentAware),
    pageTranslation: {
      ...configWith(enableAIContentAware).pageTranslation,
      requestQueueConfig: { rate: 100, capacity: 100 },
      batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
    },
  })
  const { setupPageTranslationHandlers } = await import("@/entrypoints/background/page-translation")
  setupPageTranslationHandlers()
  const { translateTextForPage } = await import("@/utils/host/translate/translate-variants")
  const session = await import("@/utils/host/translate/translation-session")
  const { sendMessage } = await import("@/utils/message")

  /** What `PageTranslationManager.stopInternal` does to the session's requests. */
  const stop = async () => {
    const ended = session.endPageTranslationSession()
    if (ended) await sendMessage("cancelPageTranslationRequests", { sessionId: ended })
  }
  return { translateTextForPage, session, stop }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
function settle(promise: Promise<unknown>): { outcome: () => Outcome | undefined } {
  let result: Outcome | undefined
  promise.then(
    (value) => {
      result = { ok: true, value }
    },
    (error: unknown) => {
      result = { ok: false, error }
    },
  )
  return { outcome: () => result }
}

const sentOf = (type: string) => bus.sent.filter((message) => message.type === type)
const summaryMessages = () => sentOf("getOrGenerateWebPageSummary")
const paragraphMessages = () => sentOf("enqueueTranslateRequest")

describe("a page paragraph's smart-context summary", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    fakeBrowser.reset()
    document.title = "Page title"
    bus.handlers.clear()
    bus.sent.length = 0
    summaryCalls = []
    paragraphCalls = []
    getOrCreateWebPageContextMock.mockResolvedValue(WEB_CONTEXT)
    generateTextMock.mockImplementation((_payload: unknown, options?: any) => {
      summaryCalls.push({ signal: options?.signal })
      return Promise.resolve("a summary")
    })
    executeTranslateMock.mockImplementation((text: string) => {
      paragraphCalls.push(text)
      return Promise.resolve(`translated ${text}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("positive controls: what must not change", () => {
    it("asks for the summary once and sends the paragraph with it", async () => {
      const { translateTextForPage, session } = await setup()
      session.beginPageTranslationSession()

      const result = await translateTextForPage("Hello there")

      expect(result).toBe("translated Hello there")
      expect(summaryMessages()).toHaveLength(1)
      expect(summaryCalls).toHaveLength(1)
      expect(paragraphMessages()).toHaveLength(1)
      expect(paragraphMessages()[0]!.data.webSummary).toBe("a summary")
    })

    it("smart context off (the default): no summary message, no summary provider call, the paragraph still goes", async () => {
      const { translateTextForPage, session } = await setup(false)
      session.beginPageTranslationSession()

      const result = await translateTextForPage("Hello there")

      expect(result).toBe("translated Hello there")
      expect(summaryMessages()).toHaveLength(0)
      expect(summaryCalls).toHaveLength(0)
      expect(paragraphMessages()).toHaveLength(1)
      expect(paragraphMessages()[0]!.data.webSummary).toBeUndefined()
    })

    it("smart context off is the shipped default", () => {
      expect(DEFAULT_CONFIG.pageTranslation.enableAIContentAware).toBe(false)
    })

    it("two paragraphs of one session share one summary provider call", async () => {
      const { translateTextForPage, session } = await setup()
      session.beginPageTranslationSession()

      await Promise.all([
        translateTextForPage("First paragraph"),
        translateTextForPage("Second paragraph"),
      ])

      expect(summaryMessages()).toHaveLength(2)
      expect(summaryCalls).toHaveLength(1)
      expect(paragraphMessages()).toHaveLength(2)
    })

    it("a request with no session asks for the summary with no owner (it pins a shared summary)", async () => {
      await setup()
      const { getOrGenerateWebPageSummary } = await import("@/utils/host/translate/webpage-summary")

      const summary = await getOrGenerateWebPageSummary(
        WEB_CONTEXT,
        { kind: "local", config: configWith(true).providersConfig[0] as never },
        true,
      )

      expect(summary).toBe("a summary")
      expect(summaryMessages()).toHaveLength(1)
      expect(summaryMessages()[0]!.data.sessionId).toBeUndefined()
    })
  })

  describe("the session owns the summary request", () => {
    it("the summary request carries the session that asked", async () => {
      const { translateTextForPage, session } = await setup()
      const sessionId = session.beginPageTranslationSession()

      await translateTextForPage("Hello there")

      expect(summaryMessages()).toHaveLength(1)
      expect(summaryMessages()[0]!.data.sessionId).toBe(sessionId)
    })

    it("stopping the session while the summary is being generated aborts it, and no paragraph follows", async () => {
      const { translateTextForPage, session, stop } = await setup()
      const held = heldSummary()
      session.beginPageTranslationSession()
      const paragraph = settle(translateTextForPage("Hello there"))
      await vi.waitFor(() => expect(summaryCalls).toHaveLength(1))
      expect(summaryCalls[0]!.signal!.aborted).toBe(false)

      await stop()
      await vi.waitFor(() => expect(summaryCalls[0]!.signal!.aborted).toBe(true))
      held.resolve("a summary")
      await vi.waitFor(() => expect(paragraph.outcome()).toBeDefined())

      const outcome = paragraph.outcome()
      expect(outcome?.ok).toBe(false)
      expect(isTranslationCancelledError((outcome as { error: unknown }).error)).toBe(true)
      expect(paragraphMessages()).toHaveLength(0)
      expect(paragraphCalls).toHaveLength(0)
    })

    it("two paragraphs of one session: stopping aborts the one summary and sends no paragraph", async () => {
      const { translateTextForPage, session, stop } = await setup()
      const held = heldSummary()
      session.beginPageTranslationSession()
      const first = settle(translateTextForPage("First paragraph"))
      const second = settle(translateTextForPage("Second paragraph"))
      await vi.waitFor(() => expect(summaryMessages()).toHaveLength(2))
      await vi.waitFor(() => expect(summaryCalls).toHaveLength(1))

      await stop()
      await vi.waitFor(() => expect(summaryCalls[0]!.signal!.aborted).toBe(true))
      held.resolve("a summary")
      await vi.waitFor(() => {
        expect(first.outcome()).toBeDefined()
        expect(second.outcome()).toBeDefined()
      })

      expect(summaryCalls).toHaveLength(1)
      expect(paragraphMessages()).toHaveLength(0)
      expect(paragraphCalls).toHaveLength(0)
    })

    it("the owner is the session captured when the paragraph started, not the one running when the summary is sent", async () => {
      const { translateTextForPage, session, stop } = await setup()
      const context = createDeferred<typeof WEB_CONTEXT>()
      getOrCreateWebPageContextMock.mockReturnValue(context.promise)
      const first = session.beginPageTranslationSession()
      const paragraph = settle(translateTextForPage("Hello there"))
      await vi.waitFor(() => expect(getOrCreateWebPageContextMock).toHaveBeenCalled())

      // The user stops and starts again while the paragraph is still preparing its context.
      await stop()
      const second = session.beginPageTranslationSession()
      context.resolve(WEB_CONTEXT)
      await vi.waitFor(() => expect(paragraph.outcome()).toBeDefined())

      expect(second).not.toBe(first)
      const messages = summaryMessages()
      expect(messages).toHaveLength(1)
      expect(messages[0]!.data.sessionId).toBe(first)
      // The stopped session's summary is not generated for the session that replaced it.
      expect(summaryCalls).toHaveLength(0)
      expect(paragraphMessages()).toHaveLength(0)
    })
  })
})
