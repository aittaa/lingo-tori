// @vitest-environment jsdom

import type { Config } from "@/types/config/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toastManager } from "@/components/ui/base-ui/toast"
import { DEFAULT_CONFIG as EMPTY_CONFIG } from "@/utils/constants/config"
import { NO_TRANSLATION_SENTINEL } from "@/utils/constants/prompt"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { detectLanguage } from "@/utils/content/language"
import { Sha256Hex } from "@/utils/hash"
import { executeTranslate } from "@/utils/host/translate/execute-translate"
import {
  MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
  translateTextCore,
  validateTranslationConfigAndToast,
} from "@/utils/host/translate/translate-text"
import {
  translateTextForPage,
  translateTextForPageTitle,
} from "@/utils/host/translate/translate-variants"
import {
  beginPageTranslationSession,
  endPageTranslationSession,
} from "@/utils/host/translate/translation-session"
import { getTranslatePrompt } from "@/utils/prompts/translate"
import { isTranslationCancelledError } from "@/utils/request/cancellation"

const DEFAULT_CONFIG = {
  ...EMPTY_CONFIG,
  providersConfig: [
    { ...DEFAULT_PROVIDER_CONFIG.deeplx, baseURL: "https://example.com/translate" },
    { ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" },
  ],
  pageTranslation: {
    ...EMPTY_CONFIG.pageTranslation,
    providerId: DEFAULT_PROVIDER_CONFIG.deeplx.id,
  },
}

// Mock dependencies
vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/api/deepl", () => ({
  deeplTranslate: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/api/deeplx", () => ({
  deeplxTranslate: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/prompts/translate", () => ({
  getTranslatePrompt: vi.fn<(...args: any[]) => any>(),
  getTranslatePromptTemplate: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/content/language", () => ({
  detectLanguage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/webpage-summary", () => ({
  getOrGenerateWebPageSummary: vi.fn<(...args: any[]) => any>(),
}))

let mockSendMessage: any
let mockDeepLTranslate: any
let mockDeepLXTranslate: any
let mockGetConfigFromStorage: any
let mockGetTranslatePrompt: any
let mockGetTranslatePromptTemplate: any
let mockGetOrCreateWebPageContext: any
let mockGetOrGenerateWebPageSummary: any
let mockDetectLanguage: any

describe("translate-text", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    document.title = "Document Title"
    document.body.innerHTML = "<main>Body content</main>"
    mockSendMessage = vi.mocked((await import("@/utils/message")).sendMessage)
    mockDeepLTranslate = vi.mocked(
      (await import("@/utils/host/translate/api/deepl")).deeplTranslate,
    )
    mockDeepLXTranslate = vi.mocked(
      (await import("@/utils/host/translate/api/deeplx")).deeplxTranslate,
    )
    mockGetConfigFromStorage = vi.mocked((await import("@/utils/config/storage")).getLocalConfig)
    mockGetTranslatePrompt = vi.mocked(
      (await import("@/utils/prompts/translate")).getTranslatePrompt,
    )
    mockGetTranslatePromptTemplate = vi.mocked(
      (await import("@/utils/prompts/translate")).getTranslatePromptTemplate,
    )
    mockGetOrCreateWebPageContext = vi.mocked(
      (await import("@/utils/host/translate/webpage-context")).getOrCreateWebPageContext,
    )
    mockGetOrGenerateWebPageSummary = vi.mocked(
      (await import("@/utils/host/translate/webpage-summary")).getOrGenerateWebPageSummary,
    )
    mockDetectLanguage = vi.mocked(detectLanguage)

    // Mock getOrCreateWebPageContext to return stable webpage metadata
    mockGetOrCreateWebPageContext.mockImplementation(() =>
      Promise.resolve({
        url: window.location.href,
        webTitle: document.title,
        webContent: document.body.textContent || "",
      }),
    )
    mockGetOrGenerateWebPageSummary.mockResolvedValue("Generated summary")

    // Mock getConfigFromStorage to return DEFAULT_CONFIG
    mockGetConfigFromStorage.mockResolvedValue(DEFAULT_CONFIG)

    // Mock getTranslatePrompt to return a simple prompt pair
    mockGetTranslatePrompt.mockResolvedValue({
      systemPrompt: "Translate to {{targetLang}}",
      prompt: "{{input}}",
    })
    mockGetTranslatePromptTemplate.mockResolvedValue({
      systemPrompt: "Translate to {{targetLanguage}}",
      prompt: "{{input}}",
    })
  })

  describe("translateTextForPage", () => {
    it("should send message with correct parameters", async () => {
      mockSendMessage.mockResolvedValue("translated text")

      const result = await translateTextForPage("test text")

      expect(result).toBe("translated text")
      const pageProvider = DEFAULT_CONFIG.providersConfig.find(
        (provider) => provider.id === DEFAULT_CONFIG.pageTranslation.providerId,
      )!
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "test text",
          langConfig: DEFAULT_CONFIG.language,
          providerRef: { kind: "local", config: pageProvider },
          scheduleAt: expect.any(Number),
          // Preserve the pre-system-provider local cache identity exactly.
          hash: Sha256Hex(
            "test text",
            JSON.stringify(pageProvider),
            DEFAULT_CONFIG.language.sourceCode,
            DEFAULT_CONFIG.language.targetCode,
            "textFormat:plain",
          ),
        }),
      )
      expect(mockGetOrCreateWebPageContext).not.toHaveBeenCalled()
      expect(mockGetOrGenerateWebPageSummary).not.toHaveBeenCalled()
    })

    it("forwards an explicit force-retranslation request without changing normal requests", async () => {
      mockSendMessage.mockResolvedValue("translated text")

      await translateTextForPage("hover text", "plain", {
        forceRetranslation: true,
      })
      await translateTextForPage("page text")

      const enqueueCalls = mockSendMessage.mock.calls.filter(
        ([type]: [string]) => type === "enqueueTranslateRequest",
      )
      expect(enqueueCalls).toHaveLength(2)
      expect(enqueueCalls[0][1]).toEqual(expect.objectContaining({ forceRetranslation: true }))
      expect(enqueueCalls[1][1].forceRetranslation).not.toBe(true)
    })

    it("maps a full no-translation sentinel response to an empty string", async () => {
      mockSendMessage.mockResolvedValue(NO_TRANSLATION_SENTINEL)

      const result = await translateTextForPage("test text")

      expect(result).toBe("")
      // One TRANSLATION request; the page also asks for the glossary snapshot.
      expect(
        mockSendMessage.mock.calls.filter(([type]: [string]) => type === "enqueueTranslateRequest"),
      ).toHaveLength(1)
    })

    it("returns a response containing the sentinel inside longer text verbatim", async () => {
      const mixed = `some translation ${NO_TRANSLATION_SENTINEL}`
      mockSendMessage.mockResolvedValue(mixed)

      const result = await translateTextForPage("test text")

      expect(result).toBe(mixed)
    })

    it("skips target-language text before sending a translation request by default", async () => {
      mockDetectLanguage.mockResolvedValueOnce(DEFAULT_CONFIG.language.targetCode)

      const targetLanguageText =
        "这是一个已经使用目标语言写成的较长段落，用于触发翻译前目标语言检测并跳过请求，同时确保文本长度超过检测阈值。"
      const result = await translateTextForPage(targetLanguageText)

      expect(result).toBe("")
      expect(mockDetectLanguage).toHaveBeenCalledWith(targetLanguageText, {
        enableLLM: false,
      })
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it("sends the translation request when target-language precheck is disabled", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          page: {
            ...DEFAULT_CONFIG.pageTranslation.page,
            enableTargetLanguageSkip: false,
          },
        },
      }
      mockGetConfigFromStorage.mockResolvedValue(config)
      mockSendMessage.mockResolvedValue("translated text")

      const targetLanguageText =
        "这是一个已经使用目标语言写成的较长段落，但关闭预检测后仍然应该发送翻译请求，同时确保文本长度超过检测阈值。"
      const result = await translateTextForPage(targetLanguageText)

      expect(result).toBe("translated text")
      expect(mockDetectLanguage).not.toHaveBeenCalled()
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: targetLanguageText,
        }),
      )
    })

    it("keeps explicit skipLanguages behavior when target-language precheck is disabled", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          page: {
            ...DEFAULT_CONFIG.pageTranslation.page,
            enableTargetLanguageSkip: false,
            skipLanguages: ["jpn"],
          },
        },
      }
      mockGetConfigFromStorage.mockResolvedValue(config)
      mockDetectLanguage.mockResolvedValueOnce("jpn")

      const japaneseText =
        "これは日本語で書かれた十分に長い段落で、明示的なスキップ言語の設定によって翻訳前にスキップされます。"
      const result = await translateTextForPage(japaneseText)

      expect(result).toBe("")
      expect(mockDetectLanguage).toHaveBeenCalledWith(japaneseText, {
        minLength: MIN_LENGTH_FOR_SKIP_LANGUAGE_DETECTION,
        enableLLM: false,
      })
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    // #1881: the session id is captured at pipeline ENTRY, but requests race
    // the awaits below (config, summary). If the user cancels mid-request the
    // request must NOT be dispatched — otherwise it lands unscoped (or after
    // the session's cancel drain) and becomes permanently uncancellable.
    describe("session cancellation gate", () => {
      afterEach(() => {
        endPageTranslationSession()
      })

      it("sends with the captured sessionId while the session stays active", async () => {
        mockSendMessage.mockResolvedValue("translated text")
        const sessionId = beginPageTranslationSession()

        await translateTextForPage("test text")

        expect(mockSendMessage).toHaveBeenCalledWith(
          "enqueueTranslateRequest",
          expect.objectContaining({ sessionId }),
        )
      })

      it("aborts without dispatching when the session ends mid-request", async () => {
        mockSendMessage.mockResolvedValue("translated text")
        beginPageTranslationSession()
        // getLocalConfig is awaited after the session id is captured; ending the
        // session here mimics a user cancel landing mid-request.
        mockGetConfigFromStorage.mockImplementation(async () => {
          endPageTranslationSession()
          return DEFAULT_CONFIG
        })

        let caught: unknown
        try {
          await translateTextForPage("test text")
        } catch (error) {
          caught = error
        }

        expect(isTranslationCancelledError(caught)).toBe(true)
        expect(mockSendMessage).not.toHaveBeenCalled()
      })

      it("aborts when a new session replaces the captured one mid-request", async () => {
        mockSendMessage.mockResolvedValue("translated text")
        beginPageTranslationSession()
        mockGetConfigFromStorage.mockImplementation(async () => {
          // restart(): old session ends, a new one begins.
          endPageTranslationSession()
          beginPageTranslationSession()
          return DEFAULT_CONFIG
        })

        let caught: unknown
        try {
          await translateTextForPage("test text")
        } catch (error) {
          caught = error
        }

        expect(isTranslationCancelledError(caught)).toBe(true)
        expect(mockSendMessage).not.toHaveBeenCalled()
      })
    })
  })

  describe("prompt template snapshot", () => {
    const template = { systemPrompt: "SNAPSHOT {{targetLanguage}}", prompt: "{{input}}" }

    function coreOptions(config: (typeof DEFAULT_CONFIG.providersConfig)[number]) {
      return {
        text: "hello world",
        langConfig: DEFAULT_CONFIG.language,
        providerConfig: { kind: "local" as const, id: config.id, name: config.name, config },
      }
    }

    function enqueuedPayload() {
      const call = mockSendMessage.mock.calls.find(
        ([type]: [string]) => type === "enqueueTranslateRequest",
      )
      return call?.[1]
    }

    it("reads the template once and hashes and sends that same object", async () => {
      mockGetTranslatePromptTemplate.mockResolvedValue(template)
      mockSendMessage.mockResolvedValue("translated")
      const llm = DEFAULT_CONFIG.providersConfig.find(
        (provider) => provider.id === "openai-default",
      )!

      await translateTextCore(coreOptions(llm))

      expect(mockGetTranslatePromptTemplate).toHaveBeenCalledTimes(1)
      expect(mockGetTranslatePrompt).toHaveBeenCalledTimes(1)
      expect(mockGetTranslatePrompt.mock.calls[0][2].promptTemplate).toBe(template)
      expect(enqueuedPayload().promptTemplate).toBe(template)
    })

    it("takes a fresh snapshot for every request", async () => {
      const edited = { systemPrompt: "EDITED {{targetLanguage}}", prompt: "{{input}}" }
      mockGetTranslatePromptTemplate.mockResolvedValueOnce(template).mockResolvedValueOnce(edited)
      mockSendMessage.mockResolvedValue("translated")
      const llm = DEFAULT_CONFIG.providersConfig.find(
        (provider) => provider.id === "openai-default",
      )!

      await translateTextCore({ ...coreOptions(llm), text: "first" })
      await translateTextCore({ ...coreOptions(llm), text: "second" })

      const payloads = mockSendMessage.mock.calls
        .filter(([type]: [string]) => type === "enqueueTranslateRequest")
        .map(([, payload]: [string, { promptTemplate: unknown }]) => payload.promptTemplate)
      expect(payloads).toEqual([template, edited])
    })

    it("holds no snapshot for a provider that takes no prompt", async () => {
      mockSendMessage.mockResolvedValue("translated")
      const pure = DEFAULT_CONFIG.providersConfig.find(
        (provider) => provider.id === "deeplx-default",
      )!

      await translateTextCore(coreOptions(pure))

      expect(mockGetTranslatePromptTemplate).not.toHaveBeenCalled()
      expect(mockGetTranslatePrompt).not.toHaveBeenCalled()
      expect(enqueuedPayload().promptTemplate).toBeUndefined()
    })
  })

  describe("translateTextForPageTitle", () => {
    it("should use the latest original title instead of document.title when building webpage context", async () => {
      const llmConfig = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: "openai-default",
          enableAIContentAware: false,
        },
      }

      mockGetConfigFromStorage.mockResolvedValue(llmConfig)
      mockSendMessage.mockImplementation(async (type: string) => {
        if (type === "enqueueTranslateRequest") {
          return "translated page title"
        }
        return undefined
      })
      document.title = "Translated Browser Title"

      const result = await translateTextForPageTitle("Source Title To Translate")

      expect(result).toBe("translated page title")
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "Source Title To Translate",
          webTitle: "Source Title To Translate",
          webContent: undefined,
        }),
      )
      expect(mockGetOrCreateWebPageContext).not.toHaveBeenCalled()
      expect(mockGetOrGenerateWebPageSummary).not.toHaveBeenCalled()
    })

    it("should include webpage content for AI-aware title translation", async () => {
      const llmConfig = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: "openai-default",
          enableAIContentAware: true,
        },
      }

      mockGetConfigFromStorage.mockResolvedValue(llmConfig)
      mockSendMessage.mockImplementation(async (type: string) => {
        if (type === "enqueueTranslateRequest") {
          return "translated page title"
        }
        return undefined
      })

      const result = await translateTextForPageTitle("Source Title To Translate")

      expect(result).toBe("translated page title")
      expect(mockGetOrCreateWebPageContext).toHaveBeenCalledTimes(1)
      expect(mockGetOrGenerateWebPageSummary).not.toHaveBeenCalled()
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "Source Title To Translate",
          webTitle: "Source Title To Translate",
          webContent: "Body content",
          webSummary: undefined,
        }),
      )
    })

    it("should forward document.title to regular page translations", async () => {
      const llmConfig = {
        ...DEFAULT_CONFIG,
        pageTranslation: {
          ...DEFAULT_CONFIG.pageTranslation,
          providerId: "openai-default",
          enableAIContentAware: false,
        },
      }

      mockGetConfigFromStorage.mockResolvedValue(llmConfig)
      mockSendMessage.mockImplementation(async (type: string) => {
        if (type === "enqueueTranslateRequest") {
          return "translated body text"
        }
        return undefined
      })
      document.title = "Translated Browser Title"

      const result = await translateTextForPage("Body text")

      expect(result).toBe("translated body text")
      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({
          text: "Body text",
          webTitle: "Translated Browser Title",
        }),
      )
    })
  })

  describe("local route mapping", () => {
    // Page requests and summaries use the same configured provider.
    const llmAiAwareConfig = {
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        providerId: "openai-default",
        enableAIContentAware: true,
      },
    }

    beforeEach(() => {
      mockGetConfigFromStorage.mockResolvedValue(llmAiAwareConfig)
      mockSendMessage.mockResolvedValue("translated")
    })

    it("uses the local provider for page translation and its summary", async () => {
      await translateTextForPage("Body text")

      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({ providerRef: expect.objectContaining({ kind: "local" }) }),
      )
      expect(mockGetOrGenerateWebPageSummary.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ kind: "local" }),
      )
    })

    it("uses the local provider for page title translation", async () => {
      await translateTextForPageTitle("Source Title")

      expect(mockSendMessage).toHaveBeenCalledWith(
        "enqueueTranslateRequest",
        expect.objectContaining({ providerRef: expect.objectContaining({ kind: "local" }) }),
      )
    })
  })

  describe("page translation without a chosen provider", () => {
    const deeplx = { ...DEFAULT_PROVIDER_CONFIG.deeplx, baseURL: "https://example.com/translate" }
    const openai = { ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }
    const sameLanguage: Config["language"] = {
      ...EMPTY_CONFIG.language,
      sourceCode: "eng",
      targetCode: "eng",
    }

    function configFor(
      pageProviderId: string,
      providersConfig: Config["providersConfig"] = [deeplx, openai],
    ): Config {
      return {
        ...EMPTY_CONFIG,
        providersConfig,
        pageTranslation: { ...EMPTY_CONFIG.pageTranslation, providerId: pageProviderId },
        language: { ...EMPTY_CONFIG.language, sourceCode: "eng", targetCode: "cmn" },
      }
    }

    function spyOnToasts() {
      return {
        add: vi.spyOn(toastManager, "add").mockReturnValue("toast-id"),
        close: vi.spyOn(toastManager, "close").mockImplementation(() => {}),
      }
    }

    // Every way the page feature's own assignment can fail to resolve.
    const unresolved: [string, Config][] = [
      ["no provider is chosen", configFor("unconfigured")],
      ["the assignment is empty", configFor("")],
      ["the chosen provider was deleted", configFor("deleted-provider")],
      ["there is no provider at all", configFor("unconfigured", [])],
      [
        "the chosen provider is disabled",
        configFor(deeplx.id, [{ ...deeplx, enabled: false }, openai]),
      ],
      [
        "the chosen provider cannot translate",
        configFor("legacy-engine", [
          // A stored row for an engine this version no longer offers for translation.
          { ...deeplx, id: "legacy-engine", provider: "legacy-engine" },
        ] as unknown as Config["providersConfig"]),
      ],
      [
        "only another feature has a working provider",
        {
          ...configFor("unconfigured"),
          videoSubtitles: { ...EMPTY_CONFIG.videoSubtitles, providerId: deeplx.id },
        },
      ],
    ]

    afterEach(() => {
      vi.restoreAllMocks()
    })

    describe("validateTranslationConfigAndToast", () => {
      it.each(unresolved)(
        "shows one provider-required toast when %s and the user asked",
        (_name, config) => {
          const toasts = spyOnToasts()

          expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
            false,
          )

          expect(toasts.add).toHaveBeenCalledTimes(1)
          expect(toasts.add).toHaveBeenCalledWith(
            expect.objectContaining({
              id: expect.any(String),
              type: "error",
              title: "providerRequired.message",
              actionProps: expect.objectContaining({ children: "providerRequired.openSettings" }),
            }),
          )
          // Showing it opens nothing and asks no provider for anything.
          expect(mockSendMessage).not.toHaveBeenCalled()
          expect(mockDeepLTranslate).not.toHaveBeenCalled()
          expect(mockDeepLXTranslate).not.toHaveBeenCalled()
        },
      )

      it.each(unresolved)("stays silent when %s and nobody asked", (_name, config) => {
        const toasts = spyOnToasts()

        expect(validateTranslationConfigAndToast(config)).toBe(false)
        expect(validateTranslationConfigAndToast(config, {})).toBe(false)
        expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: false })).toBe(
          false,
        )

        expect(toasts.add).not.toHaveBeenCalled()
      })

      it("opens the page translation row of the feature providers only when the action is pressed", () => {
        const toasts = spyOnToasts()
        validateTranslationConfigAndToast(configFor("unconfigured"), {
          notifyMissingProvider: true,
        })

        expect(mockSendMessage).not.toHaveBeenCalled()

        const toast = toasts.add.mock.calls[0]![0]
        toast.actionProps?.onClick?.({} as never)

        expect(toasts.close).toHaveBeenCalledWith(toast.id)
        expect(mockSendMessage).toHaveBeenCalledTimes(1)
        expect(mockSendMessage).toHaveBeenCalledWith("openOptionsPage", {
          route: "/api-providers?section=feature-provider-pageTranslation",
        })
      })

      it("reuses one toast id across repeated attempts", () => {
        const toasts = spyOnToasts()
        const config = configFor("unconfigured")

        validateTranslationConfigAndToast(config, { notifyMissingProvider: true })
        validateTranslationConfigAndToast(config, { notifyMissingProvider: true })

        const ids = toasts.add.mock.calls.map(([toast]) => toast.id)
        expect(ids).toHaveLength(2)
        expect(new Set(ids).size).toBe(1)
      })

      it("says only that a provider is needed when the languages also match", () => {
        const toasts = spyOnToasts()

        validateTranslationConfigAndToast(
          { ...configFor("unconfigured"), language: sameLanguage },
          { notifyMissingProvider: true },
        )

        expect(toasts.add).toHaveBeenCalledTimes(1)
        expect(toasts.add).toHaveBeenCalledWith(
          expect.objectContaining({ title: "providerRequired.message" }),
        )
      })

      it("accepts a chosen, enabled provider without a toast, whether or not the user asked", () => {
        const toasts = spyOnToasts()
        const config = configFor(deeplx.id)

        expect(validateTranslationConfigAndToast(config)).toBe(true)
        expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
          true,
        )

        expect(toasts.add).not.toHaveBeenCalled()
      })

      it("keeps the same-language message, whether or not the user asked", () => {
        const toasts = spyOnToasts()
        const config = { ...configFor(deeplx.id), language: sameLanguage }

        expect(validateTranslationConfigAndToast(config)).toBe(false)
        expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
          false,
        )

        expect(toasts.add.mock.calls.map(([toast]) => toast.title)).toEqual([
          "translation.sameLanguage",
          "translation.sameLanguage",
        ])
      })

      it("keeps the missing API key message, whether or not the user asked", () => {
        const toasts = spyOnToasts()
        const keyless = { ...DEFAULT_PROVIDER_CONFIG.openai }
        const config = configFor(keyless.id, [keyless])

        expect(validateTranslationConfigAndToast(config)).toBe(false)
        expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
          false,
        )

        expect(toasts.add.mock.calls.map(([toast]) => toast.title)).toEqual([
          "noAPIKeyConfig.warning",
          "noAPIKeyConfig.warning",
        ])
      })

      describe("API key precheck", () => {
        // A local mock server address. Nothing dials it: the precheck only reads the config,
        // and the fetch stub fails the test if that ever stops being true.
        const MOCK_ENDPOINT = "http://127.0.0.1:1234/v1"
        const fetchStub = vi.fn<(...args: any[]) => any>()

        type ProviderRow = Config["providersConfig"][number]

        beforeEach(() => {
          fetchStub.mockReset()
          vi.stubGlobal("fetch", fetchStub)
        })

        afterEach(() => {
          vi.unstubAllGlobals()
        })

        function expectNothingRequested() {
          expect(fetchStub).not.toHaveBeenCalled()
          expect(mockSendMessage).not.toHaveBeenCalled()
          expect(mockDeepLTranslate).not.toHaveBeenCalled()
          expect(mockDeepLXTranslate).not.toHaveBeenCalled()
        }

        // The custom endpoints `getLanguageModelForConfig` builds without ever asking for a key:
        // a local server may authenticate some other way, or not at all.
        const keylessEndpoints: [string, ProviderRow][] = [
          [
            "a custom OpenAI-compatible endpoint with no key",
            { ...DEFAULT_PROVIDER_CONFIG["openai-compatible"], baseURL: MOCK_ENDPOINT },
          ],
          [
            "a custom OpenAI-compatible endpoint with a blank key",
            {
              ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
              baseURL: MOCK_ENDPOINT,
              apiKey: "   ",
            },
          ],
          [
            "a custom Open Responses endpoint with no key",
            { ...DEFAULT_PROVIDER_CONFIG["open-responses"], url: `${MOCK_ENDPOINT}/responses` },
          ],
          [
            "a custom Open Responses endpoint with a blank key",
            {
              ...DEFAULT_PROVIDER_CONFIG["open-responses"],
              url: `${MOCK_ENDPOINT}/responses`,
              apiKey: "",
            },
          ],
        ]

        // Never needed a key here, and still must not.
        const keylessByDesign: [string, ProviderRow][] = [
          ["DeepLX", deeplx],
          ["Ollama", { ...DEFAULT_PROVIDER_CONFIG.ollama }],
          ["ChatGPT", { ...DEFAULT_PROVIDER_CONFIG.byos }],
        ]

        // Services that authenticate with a key of the user's own, so a missing one is an error.
        const keyRequired: [string, ProviderRow][] = [
          ["OpenAI", { ...DEFAULT_PROVIDER_CONFIG.openai }],
          ["Anthropic", { ...DEFAULT_PROVIDER_CONFIG.anthropic }],
          [
            "OpenRouter, a hosted OpenAI-compatible service",
            { ...DEFAULT_PROVIDER_CONFIG.openrouter },
          ],
          ["Alibaba, which ships with a hosted base URL", { ...DEFAULT_PROVIDER_CONFIG.alibaba }],
          ["DeepL", { ...DEFAULT_PROVIDER_CONFIG.deepl }],
        ]

        it.each(keylessEndpoints)("accepts %s", (_name, provider) => {
          const toasts = spyOnToasts()
          const config = configFor(provider.id, [provider])

          expect(validateTranslationConfigAndToast(config)).toBe(true)
          expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
            true,
          )

          expect(toasts.add).not.toHaveBeenCalled()
          expectNothingRequested()
        })

        it.each(keylessByDesign)("keeps accepting %s with no API key", (_name, provider) => {
          const toasts = spyOnToasts()
          const config = configFor(provider.id, [provider])

          expect(validateTranslationConfigAndToast(config)).toBe(true)
          expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
            true,
          )

          expect(toasts.add).not.toHaveBeenCalled()
          expectNothingRequested()
        })

        it.each(keyRequired)(
          "keeps asking for an API key for %s until one is set",
          (_name, row) => {
            const toasts = spyOnToasts()

            for (const apiKey of [undefined, "", "   "]) {
              const provider = { ...row, apiKey } as ProviderRow
              expect(validateTranslationConfigAndToast(configFor(provider.id, [provider]))).toBe(
                false,
              )
            }
            expect(toasts.add.mock.calls.map(([toast]) => toast.title)).toEqual([
              "noAPIKeyConfig.warning",
              "noAPIKeyConfig.warning",
              "noAPIKeyConfig.warning",
            ])

            toasts.add.mockClear()
            const keyed = { ...row, apiKey: "test-key" } as ProviderRow
            expect(validateTranslationConfigAndToast(configFor(keyed.id, [keyed]))).toBe(true)
            expect(toasts.add).not.toHaveBeenCalled()
            expectNothingRequested()
          },
        )

        it("still reports matching languages before accepting a keyless endpoint", () => {
          const toasts = spyOnToasts()
          const [, provider] = keylessEndpoints[0]!
          const config = { ...configFor(provider.id, [provider]), language: sameLanguage }

          expect(validateTranslationConfigAndToast(config)).toBe(false)

          expect(toasts.add.mock.calls.map(([toast]) => toast.title)).toEqual([
            "translation.sameLanguage",
          ])
        })

        it("still asks for a provider when a keyless endpoint is disabled", () => {
          const toasts = spyOnToasts()
          const [, endpoint] = keylessEndpoints[0]!
          const provider = { ...endpoint, enabled: false }
          const config = configFor(provider.id, [provider])

          expect(validateTranslationConfigAndToast(config, { notifyMissingProvider: true })).toBe(
            false,
          )

          expect(toasts.add.mock.calls.map(([toast]) => toast.title)).toEqual([
            "providerRequired.message",
          ])
        })
      })
    })

    describe("a manual node translation", () => {
      it("says a provider is needed instead of failing silently, and requests nothing", async () => {
        const { removeOrShowNodeTranslation } =
          await import("@/utils/host/translate/node-manipulation")
        const toasts = spyOnToasts()
        document.body.innerHTML = '<div id="pointed-at">A paragraph the reader pointed at.</div>'
        const node = document.getElementById("pointed-at")!
        const originalElementFromPoint = Reflect.get(document, "elementFromPoint")
        document.elementFromPoint = vi.fn<(...args: any[]) => any>(() => node)

        try {
          await expect(
            removeOrShowNodeTranslation({ x: 10, y: 10 }, configFor("unconfigured")),
          ).resolves.toBe(false)
        } finally {
          document.elementFromPoint = originalElementFromPoint
        }

        expect(toasts.add).toHaveBeenCalledTimes(1)
        expect(toasts.add).toHaveBeenCalledWith(
          expect.objectContaining({ title: "providerRequired.message" }),
        )
        expect(mockSendMessage).not.toHaveBeenCalled()
        expect(node.children).toHaveLength(0)
      })
    })
  })

  describe("executeTranslate", () => {
    const langConfig = {
      sourceCode: "eng" as const,
      targetCode: "cmn" as const,
      detectedCode: "eng" as const,
      level: "intermediate" as const,
    }

    const providerConfig = {
      id: "deeplx-default",
      enabled: true,
      name: "DeepLX",
      provider: "deeplx" as const,
    }

    it("should return empty string for empty/whitespace input", async () => {
      expect(await executeTranslate("", langConfig, providerConfig, getTranslatePrompt)).toBe("")
      expect(await executeTranslate(" ", langConfig, providerConfig, getTranslatePrompt)).toBe("")
      expect(await executeTranslate("\n", langConfig, providerConfig, getTranslatePrompt)).toBe("")
      expect(await executeTranslate(" \n ", langConfig, providerConfig, getTranslatePrompt)).toBe(
        "",
      )
      expect(await executeTranslate(" \n \t", langConfig, providerConfig, getTranslatePrompt)).toBe(
        "",
      )
    })

    it("should handle zero-width spaces correctly", async () => {
      // Only zero-width spaces should return empty
      expect(
        await executeTranslate("\u200B\u200B", langConfig, providerConfig, getTranslatePrompt),
      ).toBe("")

      // Mixed invisible + whitespace should return empty
      expect(
        await executeTranslate("\u200B \u200B", langConfig, providerConfig, getTranslatePrompt),
      ).toBe("")

      // Should translate valid content after removing zero-width spaces
      mockDeepLXTranslate.mockResolvedValue("你好")
      const result = await executeTranslate(
        "\u200B hello \u200B",
        langConfig,
        providerConfig,
        getTranslatePrompt,
      )
      expect(result).toBe("你好")
      // Shared translation core should send minimally prepared text to the provider
      expect(mockDeepLXTranslate).toHaveBeenCalledWith("hello", "en", "zh-CN", providerConfig, {
        textFormat: undefined,
        signal: undefined,
      })
    })

    it("should trim translation result", async () => {
      mockDeepLXTranslate.mockResolvedValue("  测试结果  ")

      const result = await executeTranslate(
        "test input",
        langConfig,
        providerConfig,
        getTranslatePrompt,
      )

      expect(result).toBe("测试结果")
    })

    it("preserves DeepLX text entities verbatim", async () => {
      const deeplxProviderConfig = {
        id: "deeplx-default",
        enabled: true,
        name: "DeepLX",
        provider: "deeplx" as const,
      }
      mockDeepLXTranslate.mockResolvedValue(
        " L&#39;Iran chiama &quot;Dichiarazione&quot; AT&amp;T &lt;span&gt; ",
      )

      const result = await executeTranslate(
        "test input",
        langConfig,
        deeplxProviderConfig,
        getTranslatePrompt,
      )

      expect(result).toBe("L&#39;Iran chiama &quot;Dichiarazione&quot; AT&amp;T &lt;span&gt;")
      expect(mockDeepLXTranslate).toHaveBeenCalledWith(
        "test input",
        "en",
        "zh-CN",
        deeplxProviderConfig,
        {
          textFormat: undefined,
        },
      )
    })

    it("forwards html text format to DeepL", async () => {
      const deeplProviderConfig = {
        id: "deepl-default",
        enabled: true,
        name: "DeepL",
        provider: "deepl" as const,
        apiKey: "test-key",
      }
      const html = '<p class="message">Hello</p>'
      mockDeepLTranslate.mockResolvedValue("<p>你好</p>")

      await executeTranslate(html, langConfig, deeplProviderConfig, getTranslatePrompt, {
        textFormat: "html",
        signal: undefined,
      })

      expect(mockDeepLTranslate).toHaveBeenCalledWith(html, "en", "zh-CN", deeplProviderConfig, {
        textFormat: "html",
        signal: undefined,
      })
    })

    it("forwards html text format to DeepLX", async () => {
      const deeplxProviderConfig = {
        id: "deeplx-default",
        enabled: true,
        name: "DeepLX",
        provider: "deeplx" as const,
        apiKey: "test-key",
        baseURL: "https://api.deeplx.org/{{apiKey}}/translate",
      }
      const html = '<p class="message">Hello</p>'
      mockDeepLXTranslate.mockResolvedValue("<p>你好</p>")

      await executeTranslate(html, langConfig, deeplxProviderConfig, getTranslatePrompt, {
        textFormat: "html",
        signal: undefined,
      })

      expect(mockDeepLXTranslate).toHaveBeenCalledWith(html, "en", "zh-CN", deeplxProviderConfig, {
        textFormat: "html",
        signal: undefined,
      })
    })
  })
})
