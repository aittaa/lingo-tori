import type { CachedWebPageContext } from "@/utils/host/translate/webpage-context"
// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ANALYTICS_SURFACE } from "@/types/analytics"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  BUILT_IN_DICTIONARY_ACTION_ID,
  BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID,
  isBuiltInActionId,
  getSelectionToolbarCustomActionTokenCellText,
} from "@/utils/constants/custom-action"
import { streamBackgroundStructuredObject } from "@/utils/content-script/background-stream-client"
import { CUSTOM_ACTION_CONTEXT_CHAR_LIMIT } from "@/utils/custom-action-prompt"
import { getBuiltInAction, getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import {
  buildCustomActionExecutionPlan,
  useCustomActionWebPageContext,
  useCustomActionExecution,
} from "../use-custom-action-execution"

const { structuredStreamMock } = vi.hoisted(() => ({
  structuredStreamMock: vi.fn<typeof streamBackgroundStructuredObject>(),
}))
vi.mock("@/utils/content-script/background-stream-client", () => ({
  streamBackgroundStructuredObject: structuredStreamMock,
}))

const getOrCreateWebPageContextMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/host/translate/webpage-context", async () => {
  const actual = await vi.importActual<typeof import("@/utils/host/translate/webpage-context")>(
    "@/utils/host/translate/webpage-context",
  )

  return {
    ...actual,
    getOrCreateWebPageContext: (...args: unknown[]) => getOrCreateWebPageContextMock(...args),
  }
})

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

function WebPageContextProbe({
  open,
  popoverSessionKey,
}: {
  open: boolean
  popoverSessionKey: number
}) {
  const webPageContext = useCustomActionWebPageContext(open, popoverSessionKey)
  const status =
    webPageContext === undefined
      ? "pending"
      : webPageContext === null
        ? "null"
        : webPageContext.webTitle

  return createElement("div", { "data-testid": "web-page-context" }, status)
}

function createCustomActionRequest() {
  const action = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)

  const provider = resolveProviderRefForCapability(
    "customAction",
    [
      {
        id: "test-openai",
        name: "Test OpenAI",
        provider: "openai",
        enabled: true,
        apiKey: "test-key",
        model: { model: "gpt-4o-mini", isCustomModel: false, customModel: null },
      },
    ],
    "test-openai",
  )

  if (!provider) {
    throw new Error("Default custom action provider must be available")
  }

  return {
    language: DEFAULT_CONFIG.language,
    action,
    provider,
  }
}

describe("useCustomActionWebPageContext", () => {
  beforeEach(() => {
    getOrCreateWebPageContextMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("ignores stale pending results after the popover closes and reopens", async () => {
    const firstRequest = createDeferredPromise<CachedWebPageContext | null>()
    const secondRequest = createDeferredPromise<CachedWebPageContext | null>()

    getOrCreateWebPageContextMock
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise)

    const { rerender } = render(
      createElement(WebPageContextProbe, { open: true, popoverSessionKey: 0 }),
    )

    expect(screen.getByTestId("web-page-context")).toHaveTextContent("pending")

    rerender(createElement(WebPageContextProbe, { open: false, popoverSessionKey: 0 }))
    rerender(createElement(WebPageContextProbe, { open: true, popoverSessionKey: 1 }))

    expect(screen.getByTestId("web-page-context")).toHaveTextContent("pending")

    await act(async () => {
      firstRequest.resolve({
        url: "https://example.com/first",
        webTitle: "First page",
        webContent: "First content",
      })
      await Promise.resolve()
    })

    expect(screen.getByTestId("web-page-context")).toHaveTextContent("pending")

    await act(async () => {
      secondRequest.resolve({
        url: "https://example.com/second",
        webTitle: "Second page",
        webContent: "Second content",
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId("web-page-context")).toHaveTextContent("Second page")
    })
  })

  it("returns to loading for a new popover session even when the previous session already resolved", async () => {
    const firstRequest = createDeferredPromise<CachedWebPageContext | null>()
    const secondRequest = createDeferredPromise<CachedWebPageContext | null>()

    getOrCreateWebPageContextMock
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise)

    const { rerender } = render(
      createElement(WebPageContextProbe, { open: true, popoverSessionKey: 0 }),
    )

    await act(async () => {
      firstRequest.resolve({
        url: "https://example.com/first",
        webTitle: "First page",
        webContent: "First content",
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId("web-page-context")).toHaveTextContent("First page")
    })

    rerender(createElement(WebPageContextProbe, { open: false, popoverSessionKey: 0 }))
    rerender(createElement(WebPageContextProbe, { open: true, popoverSessionKey: 1 }))

    expect(screen.getByTestId("web-page-context")).toHaveTextContent("pending")

    await act(async () => {
      secondRequest.resolve({
        url: "https://example.com/second",
        webTitle: "Second page",
        webContent: "Second content",
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId("web-page-context")).toHaveTextContent("Second page")
    })
  })
})

describe("buildCustomActionExecutionPlan", () => {
  it("truncates paragraph context tokens and trusts the canonical webpage content", () => {
    const contextText = "x".repeat(CUSTOM_ACTION_CONTEXT_CHAR_LIMIT + 128)
    const webPageContext: CachedWebPageContext = {
      url: "https://example.com/article",
      webTitle: "Example page",
      webContent: "y".repeat(CUSTOM_ACTION_CONTEXT_CHAR_LIMIT),
    }
    const plan = buildCustomActionExecutionPlan(
      createCustomActionRequest(),
      "Selected text",
      contextText,
      webPageContext,
    )

    expect(plan.error).toBeNull()
    expect(plan.executionContext?.promptTokens.paragraphs).toBe(
      contextText.slice(0, CUSTOM_ACTION_CONTEXT_CHAR_LIMIT),
    )
    expect(plan.executionContext?.promptTokens.webContent).toBe(webPageContext.webContent)
    expect(plan.executionContext?.promptTokens.selection).toBe("Selected text")
    expect(plan.executionContext?.promptTokens.webUrl).toBe(webPageContext.url)
  })

  it("falls back to the live location when the webpage context is unavailable", () => {
    const plan = buildCustomActionExecutionPlan(
      createCustomActionRequest(),
      "Selected text",
      "context",
      null,
    )

    expect(plan.error).toBeNull()
    expect(plan.executionContext?.promptTokens.webUrl).toBe(window.location.href)
  })
})

describe("retained action feature attribution", () => {
  beforeEach(() => {
    structuredStreamMock.mockReset()
    structuredStreamMock.mockResolvedValue({
      output: { result: "synthetic result" },
      thinking: { status: "complete", text: "" },
    })
  })
  it.each([
    [BUILT_IN_DICTIONARY_ACTION_ID, "dictionary"],
    [BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID, "sentenceAnalysis"],
    ["synthetic-custom-action", "customAction"],
  ] as const)(
    "tags %s as %s while preserving the captured provider and prompt",
    async (id, feature) => {
      const request = createCustomActionRequest()
      const action = isBuiltInActionId(id)
        ? getBuiltInAction(DEFAULT_CONFIG.selectionToolbar, id)
        : { ...request.action, id }
      const plan = buildCustomActionExecutionPlan(
        {
          ...request,
          action: {
            ...action,
            prompt: `Explain ${getSelectionToolbarCustomActionTokenCellText("selection")}`,
          },
        },
        "synthetic selection",
        "synthetic context",
        null,
      )
      expect(plan.error).toBeNull()
      expect(plan.executionContext).not.toBeNull()
      const hook = renderHook(() =>
        useCustomActionExecution({
          analyticsSurface: ANALYTICS_SURFACE.SELECTION_TOOLBAR,
          bodyRef: { current: null },
          executionContext: plan.executionContext,
          open: true,
          popoverSessionKey: 0,
          rerunNonce: 0,
        }),
      )
      await waitFor(() => expect(hook.result.current.isRunning).toBe(false))
      expect(structuredStreamMock).toHaveBeenCalledTimes(1)
      expect(structuredStreamMock.mock.calls[0]?.[0]).toMatchObject({
        usageFeature: feature,
        providerId: "test-openai",
      })
      expect(structuredStreamMock.mock.calls[0]?.[0].prompt).toContain("synthetic selection")
      expect(structuredStreamMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
      hook.unmount()
    },
  )
})
