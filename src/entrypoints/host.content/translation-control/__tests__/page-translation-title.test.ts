// @vitest-environment jsdom

import type { SurfaceByFeature } from "@/types/analytics"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { DEFAULT_CONFIG as EMPTY_CONFIG } from "@/utils/constants/config"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { PageTranslationManager } from "../page-translation"

const DEFAULT_CONFIG = {
  ...EMPTY_CONFIG,
  providersConfig: [
    {
      id: "test-deepl",
      provider: "deepl" as const,
      enabled: true,
      name: "Test DeepL",
      apiKey: "test-key",
    },
  ],
  pageTranslation: { ...EMPTY_CONFIG.pageTranslation, providerId: "test-deepl" },
}

const {
  mockDeepQueryTopLevelSelector,
  mockGetDetectedCodeFromStorage,
  mockGetLocalConfig,
  mockGetOrCreateWebPageContext,
  mockRemoveAllTranslatedWrapperNodes,
  mockSendMessage,
  mockTranslateTextForPageTitle,
  mockTranslateWalkedElement,
  mockValidateTranslationConfigAndToast,
  mockWalkAndLabelElement,
} = vi.hoisted(() => ({
  mockGetDetectedCodeFromStorage: vi.fn<(...args: any[]) => any>(),
  mockGetLocalConfig: vi.fn<(...args: any[]) => any>(),
  mockDeepQueryTopLevelSelector: vi.fn<(...args: any[]) => any>(),
  mockWalkAndLabelElement: vi.fn<(...args: any[]) => any>(),
  mockRemoveAllTranslatedWrapperNodes: vi.fn<(...args: any[]) => any>(),
  mockTranslateWalkedElement: vi.fn<(...args: any[]) => any>(),
  mockTranslateTextForPageTitle: vi.fn<(...args: any[]) => any>(),
  mockGetOrCreateWebPageContext: vi.fn<(...args: any[]) => any>(),
  mockValidateTranslationConfigAndToast: vi.fn<(...args: any[]) => any>(),
  mockSendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/config/languages", () => ({
  getDetectedCodeFromStorage: mockGetDetectedCodeFromStorage,
}))

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: mockGetLocalConfig,
}))

vi.mock("@/utils/host/dom/filter", () => ({
  hasNoWalkAncestor: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
  isDontWalkIntoAndDontTranslateAsChildElement: vi
    .fn<(...args: any[]) => any>()
    .mockReturnValue(false),
  isDontWalkIntoButTranslateAsChildElement: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
  isWalkBlockedElement: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
  isHTMLElement: (node: unknown) => node instanceof HTMLElement,
  isTranslatedWrapperNode: (node: unknown) =>
    node instanceof HTMLElement && node.classList.contains("read-frog-translated-content-wrapper"),
}))

vi.mock("@/utils/host/dom/find", () => ({
  deepQueryTopLevelSelector: mockDeepQueryTopLevelSelector,
}))

vi.mock("@/utils/host/dom/traversal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/dom/traversal")>()),
  walkAndLabelElement: mockWalkAndLabelElement,
  walkAndLabelElementChunked: vi
    .fn<(...args: any[]) => any>()
    .mockResolvedValue({ forceBlock: false, isInlineNode: false }),
}))

vi.mock("@/utils/host/translate/node-manipulation", () => ({
  removeAllTranslatedWrapperNodes: mockRemoveAllTranslatedWrapperNodes,
  translateWalkedElement: mockTranslateWalkedElement,
}))

vi.mock("@/utils/host/translate/translate-variants", () => ({
  translateTextForPageTitle: mockTranslateTextForPageTitle,
}))

vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: mockGetOrCreateWebPageContext,
}))

vi.mock("@/utils/host/translate/translate-text", () => ({
  validateTranslationConfigAndToast: mockValidateTranslationConfigAndToast,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: vi.fn<(...args: any[]) => any>(),
    info: vi.fn<(...args: any[]) => any>(),
    warn: vi.fn<(...args: any[]) => any>(),
  },
}))

vi.mock("@/utils/message", () => ({
  sendMessage: mockSendMessage,
}))

class MockIntersectionObserver {
  observe = vi.fn<(...args: any[]) => any>()
  unobserve = vi.fn<(...args: any[]) => any>()
  disconnect = vi.fn<(...args: any[]) => any>()
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })

  return { promise, resolve }
}

async function flushDomUpdates(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe("pageTranslationManager title handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()

    document.head.innerHTML = ""
    document.body.innerHTML = "<main>Article body</main>"
    document.title = "Original Title"
    delete window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)

    mockGetDetectedCodeFromStorage.mockResolvedValue("eng")
    mockGetLocalConfig.mockResolvedValue(DEFAULT_CONFIG)
    mockDeepQueryTopLevelSelector.mockReturnValue([])
    mockGetOrCreateWebPageContext.mockResolvedValue({
      url: window.location.href,
      webTitle: "Original Title",
      webContent: "Article body",
    })
    mockValidateTranslationConfigAndToast.mockReturnValue(true)
    mockSendMessage.mockResolvedValue(undefined)
  })

  it("does not prime webpage context on start for non-llm translation", async () => {
    mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()

    expect(mockGetOrCreateWebPageContext).not.toHaveBeenCalled()

    manager.stop()
  })

  it("primes webpage context on start for AI-aware llm translation", async () => {
    mockGetLocalConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      providersConfig: [
        {
          id: "openai-default",
          name: "Test OpenAI",
          provider: "openai",
          enabled: true,
          apiKey: "test-key",
          model: { model: "gpt-4o-mini", isCustomModel: false, customModel: null },
        },
      ],
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        providerId: "openai-default",
        enableAIContentAware: true,
      },
    })
    mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()

    expect(mockGetOrCreateWebPageContext).toHaveBeenCalledTimes(1)

    manager.stop()
  })

  it("translates the tab title on start and restores the latest source title on stop", async () => {
    mockTranslateTextForPageTitle
      .mockResolvedValueOnce("Translated Title")
      .mockResolvedValueOnce("Translated Updated Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()

    expect(document.title).toBe("Translated Title")
    expect(mockTranslateTextForPageTitle).toHaveBeenCalledTimes(1)
    expect(mockTranslateTextForPageTitle).toHaveBeenCalledWith("Original Title")

    document.title = "Updated Source Title"
    await flushDomUpdates()

    expect(mockTranslateTextForPageTitle).toHaveBeenCalledTimes(2)
    expect(mockTranslateTextForPageTitle).toHaveBeenLastCalledWith("Updated Source Title")
    expect(document.title).toBe("Translated Updated Title")

    manager.stop()

    expect(document.title).toBe("Updated Source Title")
    expect(mockSendMessage).toHaveBeenCalledWith(
      "setAndNotifyPageTranslationStateChangedByManager",
      {
        enabled: true,
        url: window.location.href,
      },
    )
    expect(mockSendMessage).toHaveBeenCalledWith(
      "setAndNotifyPageTranslationStateChangedByManager",
      {
        enabled: false,
        url: window.location.href,
      },
    )
  })

  it("keeps the page's own title readable for prompts while the tab shows the translation", async () => {
    mockTranslateTextForPageTitle
      .mockResolvedValueOnce("Translated Title")
      .mockResolvedValueOnce("Translated Updated Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()

    expect(document.title).toBe("Translated Title")
    expect(getSourceDocumentTitle()).toBe("Original Title")

    document.title = "Updated Source Title"
    await flushDomUpdates()

    expect(document.title).toBe("Translated Updated Title")
    expect(getSourceDocumentTitle()).toBe("Updated Source Title")

    manager.stop()

    expect(document.title).toBe("Updated Source Title")
    expect(window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__).toBeUndefined()
  })

  it("leaves the tab title alone when title translation is switched off", async () => {
    mockGetLocalConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      pageTranslation: {
        ...DEFAULT_CONFIG.pageTranslation,
        page: { ...DEFAULT_CONFIG.pageTranslation.page, translateTitle: false },
      },
    })
    mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()

    expect(manager.isActive).toBe(true)
    expect(document.title).toBe("Original Title")

    document.title = "Updated Source Title"
    await flushDomUpdates()

    expect(document.title).toBe("Updated Source Title")
    expect(mockTranslateTextForPageTitle).not.toHaveBeenCalled()
    expect(getSourceDocumentTitle()).toBe("Updated Source Title")

    manager.stop()

    expect(document.title).toBe("Updated Source Title")
  })

  it("switches title translation off and on without touching the translated page", async () => {
    mockTranslateTextForPageTitle
      .mockResolvedValueOnce("Translated Title")
      .mockResolvedValueOnce("Translated Later Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()
    expect(document.title).toBe("Translated Title")

    manager.setTitleTranslationEnabled(false)

    expect(document.title).toBe("Original Title")
    expect(window.__READ_FROG_TRANSLATED_DOCUMENT_TITLE__).toBeUndefined()
    expect(manager.isActive).toBe(true)
    expect(mockRemoveAllTranslatedWrapperNodes).not.toHaveBeenCalled()

    document.title = "Later Source Title"
    await flushDomUpdates()
    expect(mockTranslateTextForPageTitle).toHaveBeenCalledTimes(1)

    manager.setTitleTranslationEnabled(true)
    await flushDomUpdates()

    expect(mockTranslateTextForPageTitle).toHaveBeenLastCalledWith("Later Source Title")
    expect(document.title).toBe("Translated Later Title")
    expect(getSourceDocumentTitle()).toBe("Later Source Title")

    manager.stop()

    expect(document.title).toBe("Later Source Title")
  })

  it("drops a title result that lands after the switch went off and on again", async () => {
    const stale = createDeferred<string>()
    const fresh = createDeferred<string>()
    mockTranslateTextForPageTitle
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)

    const manager = new PageTranslationManager()
    await manager.start()
    manager.setTitleTranslationEnabled(false)
    manager.setTitleTranslationEnabled(true)

    stale.resolve("Stale Translation")
    await flushDomUpdates()
    expect(document.title).toBe("Original Title")

    fresh.resolve("Fresh Translation")
    await flushDomUpdates()
    expect(document.title).toBe("Fresh Translation")

    manager.stop()
  })

  it("honors a switch flipped while start is still awaiting", async () => {
    const notified = createDeferred<undefined>()
    mockSendMessage.mockImplementationOnce(() => notified.promise)
    mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")

    const manager = new PageTranslationManager()
    const starting = manager.start()
    await flushDomUpdates()

    manager.setTitleTranslationEnabled(false)
    notified.resolve(undefined)
    await starting
    await flushDomUpdates()

    expect(manager.isActive).toBe(true)
    expect(document.title).toBe("Original Title")
    expect(mockTranslateTextForPageTitle).not.toHaveBeenCalled()

    manager.stop()
  })

  it("does not retrigger title translation for its own managed title updates", async () => {
    mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()
    await flushDomUpdates()

    expect(document.title).toBe("Translated Title")
    expect(mockTranslateTextForPageTitle).toHaveBeenCalledTimes(1)

    manager.stop()
  })

  it("ignores stale translation results when the source title changes mid-request", async () => {
    const firstTranslation = createDeferred<string>()
    const secondTranslation = createDeferred<string>()

    mockTranslateTextForPageTitle
      .mockImplementationOnce(() => firstTranslation.promise)
      .mockImplementationOnce(() => secondTranslation.promise)

    const manager = new PageTranslationManager()
    await manager.start()
    await flushDomUpdates()

    document.title = "Updated Source Title"
    await flushDomUpdates()

    expect(mockTranslateTextForPageTitle).toHaveBeenCalledTimes(2)

    firstTranslation.resolve("Stale Translation")
    await flushDomUpdates()

    expect(document.title).toBe("Updated Source Title")

    secondTranslation.resolve("Fresh Translation")
    await flushDomUpdates()

    expect(document.title).toBe("Fresh Translation")

    manager.stop()
    expect(document.title).toBe("Updated Source Title")
  })

  describe("when no provider is chosen for page translation", () => {
    beforeEach(() => {
      mockValidateTranslationConfigAndToast.mockReturnValue(false)
    })

    function startedFrom(surface: SurfaceByFeature["page_translation"]) {
      return createFeatureUsageContext(ANALYTICS_FEATURE.PAGE_TRANSLATION, surface)
    }

    // What the manager adds to the check is only who asked; the validator owns the toast.
    function feedbackRequested(): unknown {
      expect(mockValidateTranslationConfigAndToast).toHaveBeenCalledTimes(1)
      return mockValidateTranslationConfigAndToast.mock.calls[0]?.[1]
    }

    function expectRefused(manager: PageTranslationManager) {
      expect(manager.isActive).toBe(false)
      // Nothing was activated, announced to the background, walked or enqueued.
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(mockWalkAndLabelElement).not.toHaveBeenCalled()
      expect(mockTranslateWalkedElement).not.toHaveBeenCalled()
      expect(mockTranslateTextForPageTitle).not.toHaveBeenCalled()
      expect(document.title).toBe("Original Title")
    }

    it.each([
      ANALYTICS_SURFACE.POPUP,
      ANALYTICS_SURFACE.FLOATING_BUTTON,
      ANALYTICS_SURFACE.CONTEXT_MENU,
      ANALYTICS_SURFACE.SHORTCUT,
      ANALYTICS_SURFACE.TOUCH_GESTURE,
    ])("asks for the missing provider to be reported when started from %s", async (surface) => {
      const manager = new PageTranslationManager()

      await manager.start(startedFrom(surface))

      expect(feedbackRequested()).toEqual({ notifyMissingProvider: true })
      expectRefused(manager)
    })

    it("stays quiet for the automatic start", async () => {
      const manager = new PageTranslationManager()

      await manager.start(startedFrom(ANALYTICS_SURFACE.PAGE_AUTO))

      expect(feedbackRequested()).toEqual({ notifyMissingProvider: false })
      expectRefused(manager)
    })

    it("stays quiet when nothing says the user started it (restore, mode change, frame sync)", async () => {
      const manager = new PageTranslationManager()

      await manager.start()

      expect(feedbackRequested()).toEqual({ notifyMissingProvider: false })
      expectRefused(manager)
    })

    it("stays quiet inside a frame, which never carries the user's context", async () => {
      vi.stubGlobal("top", {})
      try {
        const manager = new PageTranslationManager()

        await manager.start(startedFrom(ANALYTICS_SURFACE.SHORTCUT))

        expect(feedbackRequested()).toEqual({ notifyMissingProvider: false })
        expectRefused(manager)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it("says nothing for a start the user cancelled before the check", async () => {
      const config = createDeferred<typeof DEFAULT_CONFIG>()
      mockGetLocalConfig.mockImplementationOnce(() => config.promise)
      const manager = new PageTranslationManager()

      const starting = manager.start(startedFrom(ANALYTICS_SURFACE.POPUP))
      manager.stop({ userInitiated: true })
      config.resolve(DEFAULT_CONFIG)
      await starting

      expect(mockValidateTranslationConfigAndToast).not.toHaveBeenCalled()
      expectRefused(manager)
    })

    it("still starts from a manual surface once a provider is chosen", async () => {
      mockValidateTranslationConfigAndToast.mockReturnValue(true)
      mockTranslateTextForPageTitle.mockResolvedValue("Translated Title")
      const manager = new PageTranslationManager()

      await manager.start(startedFrom(ANALYTICS_SURFACE.POPUP))

      expect(feedbackRequested()).toEqual({ notifyMissingProvider: true })
      expect(manager.isActive).toBe(true)
      expect(mockSendMessage).toHaveBeenCalledWith(
        "setAndNotifyPageTranslationStateChangedByManager",
        { enabled: true, url: window.location.href },
      )

      manager.stop()
    })
  })
})
