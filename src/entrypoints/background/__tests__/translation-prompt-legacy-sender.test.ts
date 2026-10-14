import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { LANG_CODE_TO_EN_NAME } from "@/lib/languages"
import { getLocalConfig } from "@/utils/config/storage"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { BATCH_SEPARATOR, DEFAULT_BATCH_TRANSLATE_PROMPT } from "@/utils/constants/prompt"
import { Sha256Hex } from "@/utils/hash"
import { prepareTranslationText } from "@/utils/host/translate/text-preparation"
import { getSubtitlesTranslatePrompt } from "@/utils/prompts/subtitles"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { getProviderCacheIdentity } from "@/utils/providers/provider-ref"

/**
 * Regression for F95-1: a sender that carries NO valid prompt snapshot (an old
 * content script still live across an extension update, or a malformed payload)
 * must not be able to decide what a snapshot-carrying request runs or what the
 * persistent cache holds for it.
 *
 * Everything between the message bus and the SDK is production code: the page and
 * subtitle handlers, `BatchQueue` (hash dedup, batch key, retry, per-item
 * fallback), `RequestQueue` (its own hash dedup), `executeTranslate`, `aiTranslate`
 * and the prompt builders, reading a config that lives in WXT's fake storage.
 * Only the message transport, the cache DB (a real in-memory Map, so a write by
 * one request is visible to the next) and the SDK are replaced; `fetch` rejects
 * so no live call is possible.
 *
 * A "legacy" request is exactly what main's content script sends today: the same
 * hash, glossary terms and revision, and no `promptTemplate`. Its hash is taken
 * over prompt A; the stored selection may have moved to B by the time it runs.
 *
 * This file imports nothing that does not already exist on this branch, so every
 * failure here is an assertion about behaviour, never a missing feature/import.
 * The `control:` tests pin the harness itself and pass on the unfixed code.
 */

type Marker = "a" | "b"

interface GenerateOptions {
  instructions: string
  prompt: string
  model?: { modelId?: string; apiKey?: string }
}

type Handler = (message: { data: Record<string, unknown>; sender?: unknown }) => Promise<string>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => Promise<any>>(),
  sent: [] as { name: string; data: any }[],
  cache: new Map<string, { key: string; translation: string; createdAt: Date }>(),
  cacheWrites: [] as { key: string; translation: string }[],
  gates: new Map<string, { promise: Promise<void>; open: () => void }>(),
  mismatchBatchCalls: { value: false },
  ensureInitializedConfig: vi.fn<(...args: any[]) => any>(),
  putBatchRequestRecord: vi.fn<(...args: any[]) => any>(),
  generateText: vi.fn<(options: GenerateOptions) => Promise<{ text: string }>>(),
  createOpenAICompatible: vi.fn<(settings: Record<string, unknown>) => unknown>((settings) => ({
    languageModel: (modelId: string) => ({ ...settings, modelId }),
  })),
}))

vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: (message: any) => Promise<any>) => {
    mocks.handlers.set(name, handler)
  },
  sendMessage: async (name: string, data: unknown) => {
    const handler = mocks.handlers.get(name)
    if (!handler) throw new Error(`No handler registered for ${name}`)
    mocks.sent.push({ name, data: structuredClone(data) })
    return handler({ data: structuredClone(data), sender: { tab: { id: 39 } } })
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
      get: async (key: string) => mocks.cache.get(key),
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

const JOINED = `\n\n${BATCH_SEPARATOR}\n\n`

const TEMPLATES: Record<
  Marker,
  { id: string; name: string; systemPrompt: string; prompt: string }
> = {
  a: {
    id: "prompt-a",
    name: "Prompt A",
    systemPrompt: "MARK-A: translate into {{targetLanguage}}.",
    prompt: "{{input}}",
  },
  b: {
    id: "prompt-b",
    name: "Prompt B",
    systemPrompt: "MARK-B: translate into {{targetLanguage}}.",
    prompt: "{{input}}",
  },
}

/** What a snapshot-carrying sender posts for each selection. */
const RAW_TEMPLATE: Record<Marker, { systemPrompt: string; prompt: string }> = {
  a: { systemPrompt: TEMPLATES.a.systemPrompt, prompt: TEMPLATES.a.prompt },
  b: { systemPrompt: TEMPLATES.b.systemPrompt, prompt: TEMPLATES.b.prompt },
}

const provider: LLMProviderConfig = {
  id: "legacy-sender-provider",
  name: "Legacy sender provider",
  provider: "openai-compatible",
  enabled: true,
  baseURL: "https://legacy-sender.example/v1",
  apiKey: "synthetic-key",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "legacy-sender-model" },
}

function configSelecting(marker: Marker) {
  const queues = {
    providerId: provider.id,
    requestQueueConfig: { rate: 10, capacity: 10 },
    batchQueueConfig: { maxCharactersPerBatch: 1000, maxItemsPerBatch: 10 },
  }
  const customPromptsConfig = {
    promptId: TEMPLATES[marker].id,
    patterns: [TEMPLATES.a, TEMPLATES.b],
  }
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [provider],
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, ...queues, customPromptsConfig },
    videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, ...queues, customPromptsConfig },
  }
}

/** The user switching the selected prompt in settings. */
async function selectPrompt(marker: Marker) {
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, configSelecting(marker))
}

/** Hold the provider call that runs `segments` under `marker` until the returned release runs. */
function holdProvider(marker: Marker, segments: string[]) {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  mocks.gates.set(`${marker}:${segments.join("|")}`, { promise, open })
  return open
}

function executedBatches() {
  return mocks.generateText.mock.calls.map(([options]) => ({
    marker: /MARK-([AB])/.exec(options.instructions)?.[1]?.toLowerCase() ?? "none",
    segments: options.prompt.split(JOINED),
    isBatch: options.instructions.includes(DEFAULT_BATCH_TRANSLATE_PROMPT),
  }))
}

/** Every translation ever persisted under `hash`, in write order. */
function writesTo(hash: string) {
  return mocks.cacheWrites.filter((write) => write.key === hash).map((write) => write.translation)
}

/** The persisted translations under `hash` that were NOT produced by `expected`. */
function foreignWrites(hash: string, expected: string) {
  return writesTo(hash).filter((translation) => translation !== expected)
}

const DEFAULT_TARGET = DEFAULT_CONFIG.language.targetCode
const providerRef = { kind: "local" as const, config: provider }

interface Route {
  label: string
  /** Register the production handler and return the production content-side entry point. */
  start: () => Promise<(text: string) => Promise<string>>
  enqueueName: "enqueueTranslateRequest" | "enqueueSubtitlesTranslateRequest"
  /** The cache key the content side derives from the prompt selected right now. */
  expectedHash: (text: string) => Promise<string>
  /** A hand-built message. A `promptTemplate` key is posted verbatim, even when invalid. */
  message: (fields: { text: string; hash: string; promptTemplate?: unknown }) => {
    data: Record<string, unknown>
    sender: { tab: { id: number } }
  }
  handler: () => Handler
}

function getHandler(name: string): Handler {
  const handler = mocks.handlers.get(name)
  if (!handler) throw new Error(`Missing handler: ${name}`)
  return handler as Handler
}

const ROUTES: Route[] = [
  {
    label: "page",
    enqueueName: "enqueueTranslateRequest",
    start: async () => {
      const { setupPageTranslationHandlers } = await import("../page-translation")
      setupPageTranslationHandlers()
      const { translateTextCore } = await import("@/utils/host/translate/translate-text")
      return (text) =>
        translateTextCore({
          text,
          langConfig: { ...DEFAULT_CONFIG.language, targetCode: DEFAULT_TARGET },
          providerConfig: { ...providerRef, id: provider.id, name: provider.name },
        })
    },
    expectedHash: async (text) => {
      const preparedText = prepareTranslationText(text)
      const { systemPrompt, prompt } = await getTranslatePrompt(
        LANG_CODE_TO_EN_NAME[DEFAULT_TARGET],
        preparedText,
        { isBatch: true, context: undefined, glossaryTerms: [] },
      )
      return Sha256Hex(
        preparedText,
        JSON.stringify(provider),
        DEFAULT_CONFIG.language.sourceCode,
        DEFAULT_TARGET,
        systemPrompt,
        prompt,
        "enableAIContentAware=false",
      )
    },
    message: (fields) => ({
      data: {
        text: fields.text,
        langConfig: { ...DEFAULT_CONFIG.language, targetCode: DEFAULT_TARGET },
        providerRef,
        hash: fields.hash,
        scheduleAt: Date.now(),
        glossaryTerms: [],
        glossaryRevision: 0,
        ...("promptTemplate" in fields ? { promptTemplate: fields.promptTemplate } : {}),
      },
      sender: { tab: { id: 39 } },
    }),
    handler: () => getHandler("enqueueTranslateRequest"),
  },
  {
    label: "subtitles",
    enqueueName: "enqueueSubtitlesTranslateRequest",
    start: async () => {
      const { setupSubtitlesTranslationHandlers } = await import("../subtitles-translation")
      setupSubtitlesTranslationHandlers()
      const { translateSubtitles } = await import("@/utils/subtitles/processor/translator")
      return async (text) => {
        const [fragment] = await translateSubtitles(
          [{ text, start: 0, end: 1_000 }],
          { videoTitle: "", videoDescription: "", subtitlesTextContent: "" },
          undefined,
          undefined,
        )
        return fragment?.translation ?? ""
      }
    },
    expectedHash: async (text) => {
      const preparedText = prepareTranslationText(text)
      const { systemPrompt, prompt } = await getSubtitlesTranslatePrompt(
        LANG_CODE_TO_EN_NAME[DEFAULT_TARGET],
        preparedText,
        {
          isBatch: true,
          context: { webTitle: null, webDescription: null, videoSummary: undefined },
          glossaryTerms: [],
        },
      )
      // The subtitle route resolves its provider from the schema-parsed config,
      // which can add defaults to the raw fixture; the cache identity is that one.
      const effective = (await getLocalConfig())?.providersConfig.find(
        (candidate) => candidate.id === provider.id,
      )
      return Sha256Hex(
        preparedText,
        getProviderCacheIdentity({ kind: "local", config: effective! }),
        DEFAULT_CONFIG.language.sourceCode,
        DEFAULT_TARGET,
        systemPrompt,
        prompt,
        "enableAIContentAware=false",
      )
    },
    message: (fields) => ({
      data: {
        text: fields.text,
        langConfig: { ...DEFAULT_CONFIG.language, targetCode: DEFAULT_TARGET },
        providerRef,
        hash: fields.hash,
        scheduleAt: Date.now(),
        glossaryTerms: [],
        glossaryRevision: 0,
        ...("promptTemplate" in fields ? { promptTemplate: fields.promptTemplate } : {}),
      },
      sender: { tab: { id: 39 } },
    }),
    handler: () => getHandler("enqueueSubtitlesTranslateRequest"),
  },
]

/** Let in-flight handlers run up to their next timer without flushing the 100 ms batch window. */
async function settle() {
  for (let turn = 0; turn < 8; turn++) await vi.advanceTimersByTimeAsync(0)
}

/** One production content-side request made under the prompt selected at this moment. */
async function submit(route: Route, translate: Awaited<ReturnType<Route["start"]>>, text: string) {
  const expectedHash = await route.expectedHash(text)
  const before = mocks.sent.filter((message) => message.name === route.enqueueName).length
  const result = translate(text)
  result.catch(() => {})
  for (let turn = 0; turn < 100; turn++) {
    if (mocks.sent.filter((message) => message.name === route.enqueueName).length > before) break
    await vi.advanceTimersByTimeAsync(0)
  }
  const payload = mocks.sent.filter((message) => message.name === route.enqueueName)[before]?.data
  if (!payload) throw new Error("Content side never enqueued the request")
  await settle()
  return { result, expectedHash, payload }
}

/** A message posted by a sender that predates the snapshot field, or a broken one. */
const LEGACY_SNAPSHOTS: [string, { promptTemplate?: unknown }][] = [
  ["absent", {}],
  ["null", { promptTemplate: null }],
  ["a bare string", { promptTemplate: "MARK-A" }],
  [
    "only one of the two prompts",
    { promptTemplate: { systemPrompt: RAW_TEMPLATE.a.systemPrompt } },
  ],
  ["non-string prompts", { promptTemplate: { systemPrompt: 1, prompt: 2 } }],
]

const X = "shared-paragraph"
const Y = "legacy-only-paragraph"

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.sent.length = 0
  mocks.cache.clear()
  mocks.cacheWrites.length = 0
  mocks.gates.clear()
  mocks.mismatchBatchCalls.value = false
  vi.useFakeTimers()
  mocks.ensureInitializedConfig.mockResolvedValue(configSelecting("a"))
  mocks.putBatchRequestRecord.mockResolvedValue(undefined)
  vi.spyOn(storage, "watch").mockReturnValue(() => {})
  mocks.generateText.mockImplementation(async ({ instructions, prompt }) => {
    const marker = /MARK-([AB])/.exec(instructions)?.[1]?.toLowerCase() ?? "none"
    const segments = prompt.split(JOINED)
    const key = `${marker}:${segments.join("|")}`
    const gate = mocks.gates.get(key)
    if (gate) {
      mocks.gates.delete(key)
      await gate.promise
    }
    const translated = segments.map((text) => `${marker}:${text}`)
    // A provider that answers a batch with the wrong number of segments, to drive
    // BatchQueue into its per-item fallback. Individual calls carry no batch rules.
    if (mocks.mismatchBatchCalls.value && instructions.includes(DEFAULT_BATCH_TRANSLATE_PROMPT)) {
      translated.push(`${marker}:surplus`)
    }
    return { text: translated.join(JOINED) }
  })
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("Live transport forbidden")),
  )
  await selectPrompt("a")
  // The fixtures must survive the config schema, or every builder would quietly
  // fall back to the product default and no marker would ever appear.
  const stored = await getLocalConfig()
  if (
    stored?.pageTranslation.customPromptsConfig.promptId !== "prompt-a" ||
    stored.videoSubtitles.customPromptsConfig.promptId !== "prompt-a"
  ) {
    throw new Error("The prompt fixtures did not survive the config schema")
  }
})

afterEach(() => {
  for (const gate of mocks.gates.values()) gate.open()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(ROUTES)("$label route: harness controls", (route) => {
  it("control: a legacy request alone resolves the stored prompt at execution, as it always did", async () => {
    await route.start()
    const hash = await route.expectedHash(X)
    const legacy = route.handler()(route.message({ text: X, hash }))
    await settle()
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)

    expect(await legacy).toBe(`b:${X}`)
    expect(executedBatches()).toEqual([expect.objectContaining({ marker: "b", segments: [X] })])
  })

  it("control: a snapshot request alone runs the template it was hashed under", async () => {
    const translate = await route.start()
    const first = await submit(route, translate, X)
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)

    expect(first.payload.hash).toBe(first.expectedHash)
    expect(first.payload.promptTemplate).toEqual(RAW_TEMPLATE.a)
    expect(await first.result).toBe(`a:${X}`)
    expect(writesTo(first.expectedHash)).toEqual([`a:${X}`])
  })

  it("control: two snapshot requests with one template, text and hash still coalesce into one call", async () => {
    await route.start()
    const hash = await route.expectedHash(X)
    const handler = route.handler()
    const first = handler(route.message({ text: X, hash, promptTemplate: RAW_TEMPLATE.a }))
    const second = handler(route.message({ text: X, hash, promptTemplate: RAW_TEMPLATE.a }))
    await settle()
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all([first, second])).toEqual([`a:${X}`, `a:${X}`])
    expect(executedBatches()).toEqual([expect.objectContaining({ marker: "a", segments: [X] })])
  })
})

describe.each(ROUTES)("$label route: legacy request cache contract", (route) => {
  it.each(LEGACY_SNAPSHOTS)(
    "legacy (%s) translates but performs no cache put, even when the stored prompt did not change",
    async (_label, legacyFields) => {
      await route.start()
      const hash = await route.expectedHash(X)
      const legacy = route.handler()(route.message({ text: X, hash, ...legacyFields }))
      await vi.advanceTimersByTimeAsync(100)

      expect(await legacy).toBe(`a:${X}`)
      expect(mocks.cacheWrites).toEqual([])
    },
  )

  it("legacy requests with one provider ID but different provider snapshots stay in separate provider calls", async () => {
    await route.start()
    const hashX = await route.expectedHash(X)
    const hashY = await route.expectedHash(Y)
    const handler = route.handler()
    const edited = {
      ...provider,
      apiKey: "edited-synthetic-key",
      model: { ...provider.model, customModel: "legacy-sender-model-edited" },
    }
    const first = handler(route.message({ text: X, hash: hashX }))
    const secondMessage = route.message({ text: Y, hash: hashY })
    secondMessage.data.providerRef = { kind: "local", config: edited }
    const second = handler(secondMessage)
    await vi.advanceTimersByTimeAsync(100)

    expect(await Promise.all([first, second])).toEqual([`a:${X}`, `a:${Y}`])
    expect(
      mocks.generateText.mock.calls.map(([options]) => ({
        modelId: options.model?.modelId,
        apiKey: options.model?.apiKey,
        segments: options.prompt.split(JOINED),
      })),
    ).toEqual([
      { modelId: "legacy-sender-model", apiKey: "synthetic-key", segments: [X] },
      { modelId: "legacy-sender-model-edited", apiKey: "edited-synthetic-key", segments: [Y] },
    ])
    expect(mocks.cacheWrites).toEqual([])
  })

  it("legacy request still reads an existing row for its hash", async () => {
    await route.start()
    const hash = await route.expectedHash(X)
    mocks.cache.set(hash, { key: hash, translation: `a:${X}`, createdAt: new Date() })

    const legacy = route.handler()(route.message({ text: X, hash }))
    await vi.advanceTimersByTimeAsync(100)

    expect(await legacy).toBe(`a:${X}`)
    expect(executedBatches()).toEqual([])
    expect(mocks.cacheWrites).toEqual([])
  })
})

describe.each(ROUTES)("$label route: legacy sender queued BEFORE a snapshot sender", (route) => {
  it.each(LEGACY_SNAPSHOTS)(
    "legacy (%s) first, snapshot second, same text and hash, stored prompt changes before dispatch",
    async (_label, legacyFields) => {
      const translate = await route.start()
      const hash = await route.expectedHash(X)
      const legacy = route.handler()(route.message({ text: X, hash, ...legacyFields }))
      legacy.catch(() => {})
      await settle()
      const snapshot = await submit(route, translate, X)
      // Same text, same hash: the two requests are indistinguishable except for the field.
      expect(snapshot.payload.hash).toBe(hash)
      expect(snapshot.payload.promptTemplate).toEqual(RAW_TEMPLATE.a)

      await selectPrompt("b")
      await vi.advanceTimersByTimeAsync(100)
      const [legacyResult, snapshotResult] = await Promise.all([legacy, snapshot.result])

      expect({
        snapshotResult,
        legacyTranslated: /^[ab]:/.test(legacyResult),
        persistedBySomeoneElse: foreignWrites(hash, `a:${X}`),
      }).toEqual({
        snapshotResult: `a:${X}`,
        legacyTranslated: true,
        persistedBySomeoneElse: [],
      })
    },
  )

  it("legacy first, snapshot second: the per-item fallback also runs the snapshot's template", async () => {
    const translate = await route.start()
    mocks.mismatchBatchCalls.value = true
    const hash = await route.expectedHash(X)
    const legacy = route.handler()(route.message({ text: X, hash }))
    legacy.catch(() => {})
    await settle()
    const snapshot = await submit(route, translate, X)
    await selectPrompt("b")
    // 100 ms window, then three backoffs (1 s, 2 s, 4 s) before the fallback.
    await vi.advanceTimersByTimeAsync(10_000)
    const [legacyResult, snapshotResult] = await Promise.all([legacy, snapshot.result])

    // Precondition: the batch path really failed and the fallback really ran.
    expect(executedBatches().some((call) => !call.isBatch)).toBe(true)
    expect({
      snapshotResult,
      legacyTranslated: /^[ab]:/.test(legacyResult),
      persistedBySomeoneElse: foreignWrites(hash, `a:${X}`),
    }).toEqual({
      snapshotResult: `a:${X}`,
      legacyTranslated: true,
      persistedBySomeoneElse: [],
    })
  })

  it("legacy batch already flushed and executing: a later snapshot request is not folded into it by the RequestQueue hash dedup", async () => {
    await route.start()
    const hash = await route.expectedHash(X)
    const handler = route.handler()
    const release = holdProvider("b", [X])
    const legacy = handler(route.message({ text: X, hash }))
    legacy.catch(() => {})
    await settle()
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)
    // Precondition: the legacy batch left BatchQueue and its provider call (B) is in flight.
    expect(executedBatches()).toEqual([expect.objectContaining({ marker: "b", segments: [X] })])

    const snapshot = handler(route.message({ text: X, hash, promptTemplate: RAW_TEMPLATE.a }))
    snapshot.catch(() => {})
    await vi.advanceTimersByTimeAsync(100)
    release()
    await settle()
    const [legacyResult, snapshotResult] = await Promise.all([legacy, snapshot])

    expect({
      snapshotResult,
      legacyTranslated: /^[ab]:/.test(legacyResult),
      persistedBySomeoneElse: foreignWrites(hash, `a:${X}`),
    }).toEqual({
      snapshotResult: `a:${X}`,
      legacyTranslated: true,
      persistedBySomeoneElse: [],
    })
  })
})

describe.each(ROUTES)("$label route: snapshot sender queued BEFORE a legacy sender", (route) => {
  it.each(LEGACY_SNAPSHOTS)(
    "snapshot first, legacy (%s) second, same text and hash, stored prompt changes before dispatch",
    async (_label, legacyFields) => {
      const translate = await route.start()
      const snapshot = await submit(route, translate, X)
      const legacy = route.handler()(
        route.message({ text: X, hash: snapshot.expectedHash, ...legacyFields }),
      )
      legacy.catch(() => {})
      await settle()
      await selectPrompt("b")
      await vi.advanceTimersByTimeAsync(100)
      const [legacyResult, snapshotResult] = await Promise.all([legacy, snapshot.result])

      expect({
        snapshotResult,
        legacyTranslated: /^[ab]:/.test(legacyResult),
        persistedBySomeoneElse: foreignWrites(snapshot.expectedHash, `a:${X}`),
      }).toEqual({
        snapshotResult: `a:${X}`,
        legacyTranslated: true,
        persistedBySomeoneElse: [],
      })
    },
  )

  it("snapshot first, legacy second: the per-item fallback runs the snapshot's template", async () => {
    const translate = await route.start()
    mocks.mismatchBatchCalls.value = true
    const snapshot = await submit(route, translate, X)
    const legacy = route.handler()(route.message({ text: X, hash: snapshot.expectedHash }))
    legacy.catch(() => {})
    await settle()
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(10_000)
    const [legacyResult, snapshotResult] = await Promise.all([legacy, snapshot.result])

    expect(executedBatches().some((call) => !call.isBatch)).toBe(true)
    expect({
      snapshotResult,
      legacyTranslated: /^[ab]:/.test(legacyResult),
      persistedBySomeoneElse: foreignWrites(snapshot.expectedHash, `a:${X}`),
    }).toEqual({
      snapshotResult: `a:${X}`,
      legacyTranslated: true,
      persistedBySomeoneElse: [],
    })
  })
})

describe.each(ROUTES)("$label route: a legacy request's persistent cache write", (route) => {
  it("sequential: a legacy run that executed prompt B under an A hash does not poison a later A request", async () => {
    const translate = await route.start()
    const hash = await route.expectedHash(X)
    const legacy = route.handler()(route.message({ text: X, hash }))
    await settle()
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)
    await legacy
    // The user goes back to prompt A; the next A request is a normal snapshot request.
    await selectPrompt("a")
    const callsBefore = mocks.generateText.mock.calls.length
    const later = await submit(route, translate, X)
    expect(later.payload.hash).toBe(hash)
    await vi.advanceTimersByTimeAsync(100)
    const laterResult = await later.result

    expect({
      laterResult,
      persistedBySomeoneElse: foreignWrites(hash, `a:${X}`),
      rowServed: mocks.cache.get(hash)?.translation,
      providerCallsForLaterRequest: mocks.generateText.mock.calls.length - callsBefore,
    }).toEqual({
      laterResult: `a:${X}`,
      persistedBySomeoneElse: [],
      rowServed: `a:${X}`,
      providerCallsForLaterRequest: 1,
    })
  })

  it("concurrent: a slower legacy batch finishing after the snapshot request does not overwrite its row", async () => {
    await route.start()
    const hashX = await route.expectedHash(X)
    const hashY = await route.expectedHash(Y)
    const handler = route.handler()
    // Two legacy members, so the legacy batch has a different RequestQueue identity
    // from the snapshot's batch of one: no dedup is involved, only the later write.
    const release = holdProvider("b", [X, Y])
    const legacyX = handler(route.message({ text: X, hash: hashX }))
    const legacyY = handler(route.message({ text: Y, hash: hashY }))
    legacyX.catch(() => {})
    legacyY.catch(() => {})
    await settle()
    await selectPrompt("b")
    await vi.advanceTimersByTimeAsync(100)
    // Precondition: the legacy batch is executing under B, held at the provider.
    expect(executedBatches()).toEqual([
      expect.objectContaining({ marker: "b", segments: [X, Y], isBatch: true }),
    ])

    const snapshot = handler(
      route.message({ text: X, hash: hashX, promptTemplate: RAW_TEMPLATE.a }),
    )
    snapshot.catch(() => {})
    await vi.advanceTimersByTimeAsync(100)
    // Precondition: the snapshot's own batch ran under A while the legacy one is still held.
    expect(executedBatches().map((call) => call.marker)).toEqual(["b", "a"])
    const snapshotResult = await snapshot

    release()
    await settle()
    await Promise.all([legacyX, legacyY])
    const later = handler(route.message({ text: X, hash: hashX, promptTemplate: RAW_TEMPLATE.a }))
    later.catch(() => {})
    await vi.advanceTimersByTimeAsync(100)

    expect({
      snapshotResult,
      persistedBySomeoneElse: foreignWrites(hashX, `a:${X}`),
      laterSnapshotRequest: await later,
    }).toEqual({
      snapshotResult: `a:${X}`,
      persistedBySomeoneElse: [],
      laterSnapshotRequest: `a:${X}`,
    })
  })
})

describe.each(ROUTES)(
  "$label route: rows that already exist (boundary, not the defect)",
  (route) => {
    // A row persisted by an earlier build (or by a legacy run before any fix) under
    // the very hash a snapshot request computes is indistinguishable from a valid
    // one: nothing in the key or the row says which prompt produced it. Telling
    // them apart takes a cache-version or cleanup decision that is outside this
    // reproduction, so this pins what happens TODAY and is expected to change only
    // with that decision.
    it("boundary: a snapshot request is served an already persisted row without any provider call", async () => {
      const translate = await route.start()
      const hash = await route.expectedHash(X)
      mocks.cache.set(hash, { key: hash, translation: `b:${X}`, createdAt: new Date(0) })

      const request = await submit(route, translate, X)
      await vi.advanceTimersByTimeAsync(100)

      expect(request.payload.hash).toBe(hash)
      expect(await request.result).toBe(`b:${X}`)
      expect(executedBatches()).toEqual([])
      expect(mocks.cacheWrites).toEqual([])
    })
  },
)
