// @vitest-environment jsdom

import type { ProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { NO_TRANSLATION_SENTINEL } from "@/utils/constants/prompt"

/**
 * C04: the page's in-tab memory tier must hold to the same contract as the persistent cache.
 *
 * The background audits every provider result for inline-atom placeholders (`{{n}}`, a rendered
 * formula standing in the text). A result that dropped, duplicated or invented one is still
 * returned and rendered, but it is NOT written to the persistent cache: the next visit deserves a
 * fresh attempt. The content script, however, put every result it received into its own memory tier,
 * so a re-request of the same paragraph in the same tab (a virtualized list recreating its nodes, a
 * retranslation) was answered from memory with the degraded text and never reached the provider.
 *
 * The contract these tests pin, over the whole connected path: a result is remembered by the tab
 * exactly when the background would persist it. The degraded result itself is displayed unchanged.
 *
 * Everything between the page and the SDK/transport is production code: `translateTextForPage`,
 * `translateTextCore`, the in-memory tier, the real `enqueueTranslateRequest` handler, `BatchQueue`,
 * `RequestQueue`, `executeTranslate`, `aiTranslate`, the DeepLX adapter, and the prompt builders. Only
 * the message transport (a double that calls the registered handler with a JSON round trip, as the
 * extension messaging does), the cache DB (an in-memory Map), the SDK (`generateText`) and `fetch`
 * (which serves only the synthetic DeepLX host) are replaced, so no live call is possible.
 *
 * `control:` tests pass on the unfixed code and guard behaviour that must not move.
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => Promise<any>>(),
  sender: { value: { tab: { id: 39 } } } as { value: { tab: { id: number; incognito?: boolean } } },
  cache: new Map<string, { key: string; translation: string; createdAt: Date }>(),
  cacheReads: [] as string[],
  cacheWrites: [] as { key: string; translation: string }[],
  /** What the provider answers, one entry per provider call, in order. */
  replies: [] as string[],
  providerCalls: [] as string[],
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
  generateText:
    vi.fn<(options: { instructions: string; prompt: string }) => Promise<{ text: string }>>(),
  fetch: vi.fn<typeof fetch>(),
  createOpenAICompatible: vi.fn<(settings: Record<string, unknown>) => unknown>((settings) => ({
    languageModel: (modelId: string) => ({ ...settings, modelId }),
  })),
}))

/** The wire: JSON in, JSON out, as the extension messaging delivers it. */
function overTheWire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) => {
    mocks.handlers.set(name, handler)
  },
  sendMessage: async (name: string, data: unknown) => {
    const handler = mocks.handlers.get(name)
    if (!handler) throw new Error(`No background handler registered for ${name}`)
    return overTheWire(await handler({ data: overTheWire(data), sender: mocks.sender.value }))
  },
}))
vi.mock("../config", () => ({ ensureInitializedConfig: mocks.ensureInitializedConfig }))
vi.mock("../translation-context-summary", () => ({
  getOrGenerateTranslationContextSummary: vi.fn<() => Promise<null>>(),
}))
vi.mock("@/utils/batch-request-record", () => ({
  putBatchRequestRecord: mocks.putBatchRequestRecord,
}))
vi.mock("@/utils/db/dexie/db", () => ({
  db: {
    translationCache: {
      get: async (key: string) => {
        mocks.cacheReads.push(key)
        return mocks.cache.get(key)
      },
      put: async (row: { key: string; translation: string; createdAt: Date }) => {
        mocks.cacheWrites.push({ key: row.key, translation: row.translation })
        mocks.cache.set(row.key, row)
      },
      delete: async (key: string) => {
        mocks.cache.delete(key)
      },
    },
  },
}))
vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: vi.fn<() => void>(), close: vi.fn<() => void>() },
}))
vi.mock("@/utils/i18n", () => ({ i18n: { t: (key: string) => key } }))
vi.mock("ai", () => ({ generateText: mocks.generateText }))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}))

const llmProvider: ProviderConfig = {
  id: "inline-atom-llm",
  name: "Inline atom LLM",
  provider: "openai-compatible",
  enabled: true,
  baseURL: "https://inline-atom.example/v1",
  apiKey: "synthetic-key",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "inline-atom-model" },
}

const deeplx: ProviderConfig = {
  id: "inline-atom-deeplx",
  name: "DeepLX",
  enabled: true,
  provider: "deeplx",
  baseURL: "https://deeplx.example.test/translate",
}

function pageConfig(providerId: string) {
  const queues = {
    providerId,
    requestQueueConfig: { rate: 20, capacity: 20 },
    batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
  }
  return {
    ...DEFAULT_CONFIG,
    language: {
      sourceCode: "eng" as const,
      targetCode: "cmn" as const,
      level: "intermediate" as const,
    },
    providersConfig: [llmProvider, deeplx],
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, ...queues },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, ...queues },
  }
}

/** Two formulas in the prose: the source carries `{{0}}` and `{{1}}`. */
const SOURCE = "Let {{0}} be the mean of {{1}} over the whole sample."
const INTACT = "设 {{0}} 为整个样本上 {{1}} 的均值。"
const DROPPED = "设 {{0}} 为整个样本的均值。"
const DUPLICATED = "设 {{0}} 为整个样本上 {{1}} 的均值，即 {{1}}。"
const INVENTED = "设 {{0}} 为整个样本上 {{1}} 的均值 {{7}}。"

async function boot(providerId: string) {
  const config = pageConfig(providerId)
  mocks.ensureInitializedConfig.mockResolvedValue(config)
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, config)
  if ((await getLocalConfig())?.pageTranslation.providerId !== providerId) {
    throw new Error("The page config fixture did not survive the config schema")
  }

  const { setupPageTranslationHandlers } = await import("../page-translation")
  setupPageTranslationHandlers()
  const { translateTextForPage } = await import("@/utils/host/translate/translate-variants")
  const { beginPageTranslationSession } = await import("@/utils/host/translate/translation-session")
  beginPageTranslationSession()

  return {
    translate: (text: string, options?: { forceRetranslation?: boolean }) =>
      translateTextForPage(text, "plain", options),
  }
}

/** Queue what the provider will answer, one entry per provider call. */
function providerWillReturn(...replies: string[]) {
  mocks.replies.push(...replies)
}

const providerCallCount = () => mocks.providerCalls.length

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.sender.value = { tab: { id: 39 } }
  mocks.cache.clear()
  mocks.cacheReads.length = 0
  mocks.cacheWrites.length = 0
  mocks.replies.length = 0
  mocks.providerCalls.length = 0
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  mocks.generateText.mockImplementation(async (options) => {
    mocks.providerCalls.push(options.prompt)
    const reply = mocks.replies.shift()
    if (reply === undefined) throw new Error("The provider was called more often than scripted")
    return { text: reply }
  })
  // Only the synthetic DeepLX host answers; everything else is refused.
  mocks.fetch.mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith("https://deeplx.example.test/")) throw new Error("Live transport forbidden")
    mocks.providerCalls.push(url)
    const reply = mocks.replies.shift()
    if (reply === undefined) throw new Error("The provider was called more often than scripted")
    return new Response(JSON.stringify({ code: 200, data: reply }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(async () => {
  const { endPageTranslationSession } = await import("@/utils/host/translate/translation-session")
  endPageTranslationSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("C04: the tab remembers a result exactly when the background would persist it", () => {
  const DEGRADED = [
    { name: "a dropped placeholder", degraded: DROPPED },
    { name: "a duplicated placeholder", degraded: DUPLICATED },
    { name: "an invented placeholder", degraded: INVENTED },
  ]

  it.each(DEGRADED)(
    "$name: shown as it came, not remembered, so the re-request asks the provider again",
    async ({ degraded }) => {
      const { translate } = await boot(llmProvider.id)
      providerWillReturn(degraded, INTACT)

      // Displayed unchanged: the page still renders what the provider said.
      await expect(translate(SOURCE)).resolves.toBe(degraded)
      // The background has never persisted it...
      expect(mocks.cacheWrites).toEqual([])
      // ...and the tab must not answer the next request with it either.
      const reRequest = await translate(SOURCE)
      expect({ reRequest, providerCalls: providerCallCount() }).toEqual({
        reRequest: INTACT,
        providerCalls: 2,
      })
    },
  )

  it("once the retry comes back correct, that result is remembered and persisted", async () => {
    const { translate } = await boot(llmProvider.id)
    providerWillReturn(DROPPED, INTACT)

    await translate(SOURCE)
    await translate(SOURCE)
    const third = await translate(SOURCE)

    expect({ third, providerCalls: providerCallCount() }).toEqual({
      third: INTACT,
      providerCalls: 2,
    })
    expect(mocks.cacheWrites.map((write) => write.translation)).toEqual([INTACT])
  })

  it("control: an intact result is remembered, so the re-request makes no second call", async () => {
    const { translate } = await boot(llmProvider.id)
    providerWillReturn(INTACT)

    await expect(translate(SOURCE)).resolves.toBe(INTACT)
    await expect(translate(SOURCE)).resolves.toBe(INTACT)

    expect(providerCallCount()).toBe(1)
    expect(mocks.cacheWrites.map((write) => write.translation)).toEqual([INTACT])
  })

  it("control: the no-translation sentinel stays exempt and is remembered as an empty result", async () => {
    const { translate } = await boot(llmProvider.id)
    providerWillReturn(NO_TRANSLATION_SENTINEL)

    await expect(translate(SOURCE)).resolves.toBe("")
    await expect(translate(SOURCE)).resolves.toBe("")

    expect(providerCallCount()).toBe(1)
    expect(mocks.cacheWrites.map((write) => write.translation)).toEqual([NO_TRANSLATION_SENTINEL])
  })

  it("control: a source with no placeholders is never audited, even if the output has a token-shaped literal", async () => {
    const { translate } = await boot(llmProvider.id)
    const text = "The template engine prints the literal braces around the input name."
    const output = "模板引擎在输入名称周围打印字面括号 {{3}}。"
    providerWillReturn(output)

    await expect(translate(text)).resolves.toBe(output)
    await expect(translate(text)).resolves.toBe(output)

    expect(providerCallCount()).toBe(1)
    expect(mocks.cacheWrites.map((write) => write.translation)).toEqual([output])
  })

  it("a pure-API provider (DeepLX) takes the same contract on the other queue path", async () => {
    const { translate } = await boot(deeplx.id)
    providerWillReturn(DROPPED, INTACT)

    await expect(translate(SOURCE)).resolves.toBe(DROPPED)
    expect(mocks.cacheWrites).toEqual([])
    const reRequest = await translate(SOURCE)

    expect({ reRequest, providerCalls: providerCallCount() }).toEqual({
      reRequest: INTACT,
      providerCalls: 2,
    })
  })

  describe("a private window", () => {
    beforeEach(() => {
      mocks.sender.value = { tab: { id: 39, incognito: true } }
    })

    it("control: keeps remembering an intact result in the tab, and touches no persistent cache", async () => {
      const { translate } = await boot(llmProvider.id)
      providerWillReturn(INTACT)

      await expect(translate(SOURCE)).resolves.toBe(INTACT)
      await expect(translate(SOURCE)).resolves.toBe(INTACT)

      expect(providerCallCount()).toBe(1)
      expect(mocks.cacheReads).toEqual([])
      expect(mocks.cacheWrites).toEqual([])
    })

    it("does not remember a degraded result either, and still touches no persistent cache", async () => {
      const { translate } = await boot(llmProvider.id)
      providerWillReturn(DROPPED, INTACT)

      await expect(translate(SOURCE)).resolves.toBe(DROPPED)
      const reRequest = await translate(SOURCE)

      expect({ reRequest, providerCalls: providerCallCount() }).toEqual({
        reRequest: INTACT,
        providerCalls: 2,
      })
      expect(mocks.cacheReads).toEqual([])
      expect(mocks.cacheWrites).toEqual([])
    })
  })

  it("a forced retranslation that comes back degraded is shown but does not replace the remembered good one", async () => {
    const { translate } = await boot(llmProvider.id)
    providerWillReturn(INTACT, DROPPED)

    await expect(translate(SOURCE)).resolves.toBe(INTACT)
    await expect(translate(SOURCE, { forceRetranslation: true })).resolves.toBe(DROPPED)
    // The persistent cache keeps the good entry (the handler skips the degraded write); the tab
    // does the same, so a later remount is not handed the degraded text.
    const remount = await translate(SOURCE)

    expect({ remount, providerCalls: providerCallCount() }).toEqual({
      remount: INTACT,
      providerCalls: 2,
    })
    expect(mocks.cacheWrites.map((write) => write.translation)).toEqual([INTACT])
  })
})
