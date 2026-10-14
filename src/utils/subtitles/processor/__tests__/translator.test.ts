import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LANG_CODE_TO_EN_NAME } from "@/lib/languages"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"

const getLocalConfigMock = vi.fn<(...args: any[]) => any>()
const sendMessageMock = vi.fn<(...args: any[]) => any>()
const getSubtitlesTranslatePromptMock = vi.fn<(...args: any[]) => any>()
const getSubtitlesPromptTemplateMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: getLocalConfigMock,
}))

vi.mock("@/utils/message", () => ({
  sendMessage: sendMessageMock,
}))

vi.mock("@/utils/prompts/subtitles", () => ({
  getSubtitlesTranslatePrompt: getSubtitlesTranslatePromptMock,
  getSubtitlesPromptTemplate: getSubtitlesPromptTemplateMock,
}))

/**
 * The enqueue calls only. Translating a fragment also asks the background for
 * the glossary that applies to this page, so `sendMessage` call 0 is no longer
 * the translation request.
 */
function enqueueRequests() {
  return sendMessageMock.mock.calls
    .filter((call) => call[0] === "enqueueSubtitlesTranslateRequest")
    .map((call) => call[1])
}

describe("subtitles translator", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    getLocalConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        enableAIContentAware: true,
      },
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: "openai-default",
      },
    })

    getSubtitlesTranslatePromptMock.mockResolvedValue({
      systemPrompt: "system",
      prompt: "prompt",
    })
    getSubtitlesPromptTemplateMock.mockResolvedValue({
      systemPrompt: "template system {{targetLanguage}}",
      prompt: "{{input}}",
    })
    sendMessageMock.mockResolvedValue("translated subtitle")
  })

  it("includes summary in subtitle requests and uses it in the cache hash", async () => {
    const { translateSubtitles } = await import("../translator")

    const fragments = [{ text: "hello", start: 0, end: 1_000 }]
    const baseContext = {
      videoTitle: "Video title",
      videoDescription: "Video description",
      subtitlesTextContent: "subtitle transcript",
    }

    await translateSubtitles(fragments, { ...baseContext, summary: "Ready summary" })
    await translateSubtitles(fragments, baseContext)

    const [firstRequest, secondRequest] = enqueueRequests()

    expect(firstRequest.webTitle).toBe("Video title")
    expect(firstRequest.webDescription).toBe("Video description")
    expect(firstRequest.subtitlesContext).toBeUndefined()
    expect(firstRequest.summary).toBe("Ready summary")
    expect(secondRequest.webTitle).toBe("Video title")
    expect(secondRequest.webDescription).toBe("Video description")
    expect(secondRequest.subtitlesContext).toBeUndefined()
    expect(secondRequest.summary).toBeUndefined()
    expect(firstRequest.hash).not.toBe(secondRequest.hash)
  })

  it("keeps summary as a distinct hash input", async () => {
    const { translateSubtitles } = await import("../translator")

    const fragments = [{ text: "hello", start: 0, end: 1_000 }]

    await translateSubtitles(fragments, {
      videoTitle: "Video title",
      videoDescription: "description-a",
      subtitlesTextContent: "subtitle transcript",
      summary: "summary-a",
    })

    await translateSubtitles(fragments, {
      videoTitle: "Video title",
      videoDescription: "description-b",
      subtitlesTextContent: "subtitle transcript",
      summary: "summary-b",
    })

    const [firstHash, secondHash] = enqueueRequests().map((request) => request.hash)

    expect(firstHash).not.toBe(secondHash)
  })

  it("requests subtitle summary through a dedicated background message", async () => {
    sendMessageMock.mockResolvedValue("Generated summary")

    const { fetchSubtitlesSummary } = await import("../translator")
    const result = await fetchSubtitlesSummary({
      videoTitle: "Video title",
      subtitlesTextContent: "subtitle transcript",
    })

    expect(result).toBe("Generated summary")
    expect(sendMessageMock).toHaveBeenCalledWith(
      "getSubtitlesSummary",
      expect.objectContaining({
        videoTitle: "Video title",
        subtitlesContext: "subtitle transcript",
        providerRef: expect.objectContaining({
          kind: "local",
          config: expect.objectContaining({ id: "openai-default" }),
        }),
      }),
    )
  })

  it("returns null when subtitle summary is unavailable", async () => {
    const { fetchSubtitlesSummary } = await import("../translator")

    sendMessageMock.mockResolvedValueOnce(null)
    const emptyFromBackground = await fetchSubtitlesSummary({
      videoTitle: "Video title",
      subtitlesTextContent: "subtitle transcript",
    })

    expect(emptyFromBackground).toBeNull()

    getLocalConfigMock.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        enableAIContentAware: false,
      },
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: "openai-default",
      },
    })

    const disabledResult = await fetchSubtitlesSummary({
      videoTitle: "Video title",
      subtitlesTextContent: "subtitle transcript",
    })

    expect(disabledResult).toBeNull()
  })

  it("preserves null summary once the subtitle summary fetch completes without data", async () => {
    const { translateSubtitles } = await import("../translator")

    await translateSubtitles([{ text: "hello", start: 0, end: 1_000 }], {
      videoTitle: "Video title",
      subtitlesTextContent: "subtitle transcript",
      summary: null,
    })

    const request = enqueueRequests()[0]
    expect(request.webTitle).toBe("Video title")
    expect(request.summary).toBeNull()
  })

  it("passes title and description when AI content awareness is disabled", async () => {
    getLocalConfigMock.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        enableAIContentAware: false,
      },
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: "openai-default",
      },
    })
    const { translateSubtitles } = await import("../translator")

    await translateSubtitles([{ text: "hello", start: 0, end: 1_000 }], {
      videoTitle: "Video title",
      videoDescription: "Video description",
      subtitlesTextContent: "subtitle transcript",
      summary: "Ready summary",
    })

    const request = enqueueRequests()[0]
    expect(request.webTitle).toBe("Video title")
    expect(request.webDescription).toBe("Video description")
    expect(request.summary).toBeUndefined()
    expect(getSubtitlesTranslatePromptMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        context: {
          webTitle: "Video title",
          webDescription: "Video description",
          videoSummary: undefined,
        },
      }),
    )
  })

  it("uses an explicit config snapshot without reading current settings again", async () => {
    const { fetchSubtitlesSummary, translateSubtitles } = await import("../translator")
    const configSnapshot = {
      ...DEFAULT_CONFIG,
      providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
      pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, enableAIContentAware: true },
      videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId: "openai-default" },
    }
    const videoContext = { videoTitle: "Video title", subtitlesTextContent: "subtitle transcript" }

    await fetchSubtitlesSummary(videoContext, configSnapshot)
    await translateSubtitles(
      [{ text: "hello", start: 0, end: 1_000 }],
      videoContext,
      configSnapshot,
    )

    expect(getLocalConfigMock).not.toHaveBeenCalled()
    // Proves the snapshot's enableAIContentAware actually reached the guard —
    // without this, a snapshot that silently fails the first guard would make
    // the not-called assertion above pass vacuously.
    expect(sendMessageMock).toHaveBeenCalledWith(
      "getSubtitlesSummary",
      expect.objectContaining({ videoTitle: "Video title" }),
    )
    expect(sendMessageMock).toHaveBeenCalledWith(
      "enqueueSubtitlesTranslateRequest",
      expect.objectContaining({ langConfig: configSnapshot.language }),
    )
  })

  describe("prompt template snapshot", () => {
    const template = { systemPrompt: "SNAPSHOT {{targetLanguage}}", prompt: "{{input}}" }
    const videoContext = { videoTitle: "Video title", subtitlesTextContent: "subtitle transcript" }

    it("reads the template once per cue and hashes and sends that same object", async () => {
      getSubtitlesPromptTemplateMock.mockResolvedValue(template)
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles([{ text: "hello", start: 0, end: 1_000 }], videoContext)

      expect(getSubtitlesPromptTemplateMock).toHaveBeenCalledTimes(1)
      expect(getSubtitlesTranslatePromptMock).toHaveBeenCalledTimes(1)
      expect(getSubtitlesTranslatePromptMock.mock.calls[0]![2].promptTemplate).toBe(template)
      expect(enqueueRequests()[0].promptTemplate).toBe(template)
    })

    it("takes a fresh snapshot for each cue", async () => {
      const edited = { systemPrompt: "EDITED {{targetLanguage}}", prompt: "{{input}}" }
      getSubtitlesPromptTemplateMock.mockResolvedValueOnce(template).mockResolvedValueOnce(edited)
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles(
        [
          { text: "first", start: 0, end: 1_000 },
          { text: "second", start: 1_000, end: 2_000 },
        ],
        videoContext,
      )

      expect(enqueueRequests().map((request) => request.promptTemplate)).toEqual([template, edited])
    })

    it("holds no snapshot for a provider that takes no prompt", async () => {
      const deeplx = { ...DEFAULT_PROVIDER_CONFIG.deeplx, baseURL: "https://example.com/translate" }
      getLocalConfigMock.mockResolvedValue({
        ...DEFAULT_CONFIG,
        providersConfig: [deeplx],
        videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId: deeplx.id },
      })
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles([{ text: "hello", start: 0, end: 1_000 }], videoContext)

      expect(enqueueRequests()).toHaveLength(1)
      expect(getSubtitlesPromptTemplateMock).not.toHaveBeenCalled()
      expect(getSubtitlesTranslatePromptMock).not.toHaveBeenCalled()
      expect(enqueueRequests()[0].promptTemplate).toBeUndefined()
    })
  })

  describe("per-cue translation outcome", () => {
    /** Resolves every cue except the ones named: "broken" rejects, "silent" resolves empty. */
    function mockPerCueOutcome() {
      sendMessageMock.mockImplementation(async (name: string, payload: { text?: string }) => {
        if (name !== "enqueueSubtitlesTranslateRequest") return "translated subtitle"
        if (payload.text === "broken") throw new Error("provider hiccup")
        if (payload.text === "silent") return ""
        return `t:${payload.text}`
      })
    }

    const videoContext = { videoTitle: "Video title", subtitlesTextContent: "subtitle transcript" }

    it("leaves a rejected cue untranslated instead of recording it as an empty translation", async () => {
      mockPerCueOutcome()
      const { translateSubtitles } = await import("../translator")

      const result = await translateSubtitles(
        [
          { text: "ok", start: 0, end: 1_000 },
          { text: "broken", start: 1_000, end: 2_000 },
          { text: "after", start: 2_000, end: 3_000 },
        ],
        videoContext,
      )

      expect(result.map((cue) => cue.translation)).toEqual(["t:ok", undefined, "t:after"])
    })

    it("does not inherit an earlier translation for a cue whose request rejected", async () => {
      mockPerCueOutcome()
      const { translateSubtitles } = await import("../translator")

      const result = await translateSubtitles(
        [
          { text: "ok", start: 0, end: 1_000 },
          { text: "broken", start: 1_000, end: 2_000, translation: "stale translation" },
        ],
        videoContext,
      )

      expect(result[1]!.translation).toBeUndefined()
    })

    it("still counts a resolved empty translation as a success", async () => {
      mockPerCueOutcome()
      const { translateSubtitles } = await import("../translator")

      const result = await translateSubtitles(
        [
          { text: "silent", start: 0, end: 1_000 },
          { text: "broken", start: 1_000, end: 2_000 },
        ],
        videoContext,
      )

      expect(result[0]!.translation).toBe("")
      expect(result[1]!.translation).toBeUndefined()
    })

    it("throws the first friendly error when every cue rejected", async () => {
      sendMessageMock.mockImplementation(async (name: string) => {
        if (name !== "enqueueSubtitlesTranslateRequest") return "translated subtitle"
        throw new Error("provider hiccup")
      })
      const { translateSubtitles } = await import("../translator")

      await expect(
        translateSubtitles(
          [
            { text: "broken", start: 0, end: 1_000 },
            { text: "broken", start: 1_000, end: 2_000 },
          ],
          videoContext,
        ),
      ).rejects.toThrow("provider hiccup")
    })
  })

  describe("a pinned target language", () => {
    const videoContext = { videoTitle: "Video title", subtitlesTextContent: "subtitle transcript" }
    const cue = [{ text: "hello", start: 0, end: 1_000 }]

    /** The settings as they stand now: Japanese is the target, and `providerId` is the provider. */
    const liveConfig = (providerId: string) => ({
      ...DEFAULT_CONFIG,
      language: { ...DEFAULT_CONFIG.language, targetCode: "jpn" as const },
      providersConfig: [
        { ...DEFAULT_PROVIDER_CONFIG.openai, id: "openai-default", apiKey: "test-key" },
        { ...DEFAULT_PROVIDER_CONFIG.openai, id: "openai-other", apiKey: "other-key" },
      ],
      videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId },
    })

    it("translates into the pinned language, not the one the settings say now", async () => {
      getLocalConfigMock.mockResolvedValue(liveConfig("openai-default"))
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles(cue, videoContext, undefined, "kor")

      const [request] = enqueueRequests()
      expect(request.langConfig.targetCode).toBe("kor")
      expect(getSubtitlesTranslatePromptMock).toHaveBeenCalledWith(
        LANG_CODE_TO_EN_NAME.kor,
        expect.any(String),
        expect.anything(),
      )
    })

    it("follows the current settings when nothing is pinned", async () => {
      getLocalConfigMock.mockResolvedValue(liveConfig("openai-default"))
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles(cue, videoContext)

      expect(enqueueRequests()[0].langConfig.targetCode).toBe("jpn")
    })

    it("keeps the cache key apart per pinned language", async () => {
      getLocalConfigMock.mockResolvedValue(liveConfig("openai-default"))
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles(cue, videoContext, undefined, "kor")
      await translateSubtitles(cue, videoContext)

      const [pinned, live] = enqueueRequests()
      expect(pinned.hash).not.toBe(live.hash)
    })

    it("still follows every other setting as it changes between batches", async () => {
      getLocalConfigMock
        .mockResolvedValueOnce(liveConfig("openai-default"))
        .mockResolvedValueOnce(liveConfig("openai-other"))
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles(cue, videoContext, undefined, "kor")
      await translateSubtitles(cue, videoContext, undefined, "kor")

      const [first, second] = enqueueRequests()
      expect(first.langConfig.targetCode).toBe("kor")
      expect(second.langConfig.targetCode).toBe("kor")
      expect(first.providerRef.config.id).toBe("openai-default")
      expect(second.providerRef.config.id).toBe("openai-other")
    })

    it("pins the language of a config snapshot too", async () => {
      const { translateSubtitles } = await import("../translator")

      await translateSubtitles(cue, videoContext, liveConfig("openai-default"), "kor")

      expect(getLocalConfigMock).not.toHaveBeenCalled()
      expect(enqueueRequests()[0].langConfig.targetCode).toBe("kor")
    })
  })

  it("builds subtitle summary context hashes from subtitles text and provider config", async () => {
    const { buildSubtitlesSummaryContextHash } = await import("../translator")

    const baseProviderRef: SerializableProviderRef = {
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

    const first = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: "same transcript",
      },
      baseProviderRef,
    )
    const sameTextDifferentTitle = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: "same transcript",
      },
      baseProviderRef,
    )
    const differentText = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: "different transcript",
      },
      baseProviderRef,
    )
    const differentProvider = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: "same transcript",
      },
      { kind: "local", config: { ...baseProviderRef.config, id: "other-provider" } } as never,
    )

    expect(first).toBe(sameTextDifferentTitle)
    expect(first).not.toBe(differentText)
    expect(first).not.toBe(differentProvider)
  })

  it("builds subtitle summary context hashes from cleaned text capped by cleanText's default limit", async () => {
    const { buildSubtitlesSummaryContextHash } = await import("../translator")

    const baseProviderRef: SerializableProviderRef = {
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

    const prefix = "a".repeat(3000)
    const first = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: `${prefix}tail-a`,
      },
      baseProviderRef,
    )
    const second = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: `${prefix}tail-b`,
      },
      baseProviderRef,
    )
    const differentWithinLimit = buildSubtitlesSummaryContextHash(
      {
        subtitlesTextContent: `${"b".repeat(3000)}tail-a`,
      },
      baseProviderRef,
    )

    expect(first).toBe(second)
    expect(first).not.toBe(differentWithinLimit)
  })
})
