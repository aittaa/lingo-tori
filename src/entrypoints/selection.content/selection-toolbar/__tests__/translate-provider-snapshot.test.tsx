// @vitest-environment jsdom
// Selection translation streams from an LLM provider. The popover computes the model's reasoning,
// provider options and temperature from the provider row it resolved (version A), then asks the
// background to stream. If that row is edited while the request is on its way, the background
// must not read the row again: the outbound request has to come from version A alone, not from
// version B's endpoint, credential, header and model paired with version A's parameters.
//
// Real: SelectionTranslationProvider, the selection atoms, resolveProviderRefForCapability, the
// content-side stream client, the background port dispatcher and text-stream handler, the model
// factory, the AI SDK and the storage helpers over the extension's in-memory browser storage.

import type { ReactNode, Ref } from "react"
import type { Config } from "@/types/config/config"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  configWith,
  expectedFrom,
  PROVIDER_ID,
  providerRow,
  storeProvider,
  summarize,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installProviderTransport } from "@/utils/content-script/__tests__/provider-transport"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import { SelectionTranslationProvider } from "../translate-button/provider"

// The popover chrome, the page context and the config atom are replaced. The selection atoms, the
// provider resolution, the provider component's own request building, the content-side stream
// client, the background port dispatcher and text-stream handler, the model factory and the AI SDK
// are real; the port transport and the provider's network edge are the doubles from the shared
// helpers.
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
  trackFeatureUsed: vi.fn<(...args: any[]) => any>(),
  translateTextCore: vi.fn<(...args: any[]) => any>(),
  // The newest handler the provider under test registered with useSelectionShortcuts.
  shortcutHandler: undefined as ((id: string, session: unknown) => boolean) | undefined,
  // onMessage listeners by message type, so a test can play the background's context-menu message.
  messageListeners: new Map<string, (message: { data: unknown }) => void>(),
  session: {
    id: 1,
    createdAt: 0,
    selectionSnapshot: { text: "Hello world" },
    contextSnapshot: { text: "Hello world, hello.", paragraphs: [] as string[] },
  },
}))

// The real config atom is storage-backed; a plain atom lets a test set the config directly.
vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  const { selectAtom } = await import("jotai/utils")
  const { DEFAULT_CONFIG: defaults } = await import("@/utils/constants/config")
  const config = atom(defaults)
  return {
    configAtom: config,
    configFieldsAtomMap: {
      language: selectAtom(config, (value) => value.language),
      providersConfig: selectAtom(config, (value) => value.providersConfig),
      selectionToolbar: selectAtom(config, (value) => value.selectionToolbar),
    },
    writeConfigAtom: atom(null, () => {}),
  }
})

vi.mock("@/utils/message", () => ({
  sendMessage: mocks.sendMessage,
  onMessage: (type: string, listener: (message: { data: unknown }) => void) => {
    mocks.messageListeners.set(type, listener)
    return () => {
      mocks.messageListeners.delete(type)
    }
  },
}))

vi.mock("@/utils/analytics", async () => ({
  ...(await vi.importActual<typeof import("@/utils/analytics")>("@/utils/analytics")),
  trackFeatureUsed: mocks.trackFeatureUsed,
}))

// Reaching this means the popover took the pure-translate-provider path, not the LLM stream.
vi.mock("@/utils/host/translate/translate-text", () => ({
  translateTextCore: mocks.translateTextCore,
}))
vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: () => Promise.resolve(null),
}))
vi.mock("@/utils/host/translate/webpage-summary", () => ({
  getOrGenerateWebPageSummary: () => Promise.resolve(null),
}))
vi.mock("@/utils/glossary/active-matcher", () => ({
  resolveGlossaryTermsFromCache: () => [],
}))
vi.mock("@/utils/glossary/analytics", () => ({
  trackGlossaryUsed: () => {},
}))
vi.mock("@/utils/prompts/translate", () => ({
  getTranslatePromptFromConfig: () => ({ systemPrompt: "system", prompt: "prompt" }),
}))

// The content script entry (shadow root) and the popover chrome.
vi.mock("../..", () => ({ shadowWrapper: undefined }))
vi.mock("@/components/ui/selection-popover", async () => {
  const { createContext, createElement: h, use, useImperativeHandle } = await import("react")
  const Popover = createContext({ open: false, onOpenChange: (_open: boolean) => {} })
  const Box = ({ children }: { children?: ReactNode }) => h("div", null, children)
  return {
    SelectionPopover: {
      Root: ({
        open,
        onOpenChange,
        actionsRef,
        children,
      }: {
        open: boolean
        onOpenChange: (open: boolean) => void
        actionsRef: Ref<unknown>
        children?: ReactNode
      }) => {
        useImperativeHandle(actionsRef, () => ({ requestOpen: () => onOpenChange(true) }))
        return h(Popover.Provider, { value: { open, onOpenChange } }, children)
      },
      Content: ({ children }: { children?: ReactNode }) =>
        use(Popover).open ? h("div", null, children) : null,
      Header: Box,
      Body: Box,
      Pin: () => null,
      Close: () => {
        const { onOpenChange } = use(Popover)
        return h("button", { onClick: () => onOpenChange(false) }, "close")
      },
    },
  }
})
vi.mock("@/components/ui/selection-popover/selection-toolbar-footer-content", async () => {
  const { createElement: h } = await import("react")
  return {
    SelectionToolbarFooterContent: ({ onRegenerate }: { onRegenerate: () => void }) =>
      h("button", { onClick: onRegenerate }, "regenerate"),
  }
})
vi.mock("@/components/ui/selection-popover/selection-toolbar-title-content", () => ({
  SelectionToolbarTitleContent: () => null,
}))
vi.mock("@/components/custom-action/custom-action-content", () => ({
  CustomActionContent: () => null,
}))
vi.mock("@/components/custom-action/custom-action-tool-button", () => ({
  CustomActionToolButton: () => null,
}))
vi.mock("../translate-button/target-language-selector", () => ({
  TargetLanguageSelector: () => null,
}))
vi.mock("../translate-button/translation-content", async () => {
  const { createElement: h } = await import("react")
  return {
    TranslationContent: ({ translatedText }: { translatedText?: string }) =>
      h("p", null, translatedText),
  }
})
vi.mock("../note-suggestion/note-suggestion-card", () => ({ NoteSuggestionCard: () => null }))
vi.mock("../note-suggestion/use-note-suggestion", () => {
  const noteSuggestion = {
    suggestion: null,
    maybeFire: () => {},
    cancel: () => {},
    resetSession: () => {},
    markShownOnce: () => {},
  }
  return { useNoteSuggestion: () => noteSuggestion }
})

// How a selection opens a popover: the shortcut handler and the context-menu message are driven
// by the tests; the open request itself always resolves to the same session.
vi.mock("../use-selection-open-request", () => {
  const anchor = { x: 1, y: 2 }
  const resolver = {
    resolveContextMenuOpenRequest: () => ({ anchor, session: mocks.session }),
    resolveShortcutOpenRequest: (session: unknown) => (session ? { anchor, session } : null),
  }
  return { useSelectionOpenRequestResolver: () => resolver }
})
vi.mock("../use-selection-shortcuts", () => ({
  useSelectionShortcuts: (
    _shortcuts: unknown,
    handler: (id: string, session: unknown) => boolean,
  ) => {
    mocks.shortcutHandler = handler
  },
}))

function selectionConfig(): Config {
  const config = configWith(providerRow("a"))
  config.selectionToolbar = {
    ...DEFAULT_CONFIG.selectionToolbar,
    features: {
      ...DEFAULT_CONFIG.selectionToolbar.features,
      translate: { ...DEFAULT_CONFIG.selectionToolbar.features.translate, providerId: PROVIDER_ID },
    },
  }
  return config
}

function mountTranslationProvider() {
  const store = createStore()
  store.set(configAtom, selectionConfig())
  render(
    createElement(Provider, { store }, createElement(SelectionTranslationProvider, null, null)),
  )
}

function openTranslationByShortcut() {
  if (!mocks.shortcutHandler) throw new Error("the provider did not register a shortcut handler")
  const handler = mocks.shortcutHandler
  act(() => {
    handler("translate", mocks.session)
  })
}

let bridge: ReturnType<typeof installStreamPortBridge>
let transport: ReturnType<typeof installProviderTransport>

beforeEach(() => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  transport = installProviderTransport("translated by the provider")
})

afterEach(() => {
  cleanup()
  bridge.dispose()
  vi.unstubAllGlobals()
  mocks.shortcutHandler = undefined
  mocks.messageListeners.clear()
  vi.clearAllMocks()
})

describe("selection translation streams from one version of its provider row", () => {
  it("sends the unedited row's endpoint, credential, header, model, temperature and options (unchanged behaviour)", async () => {
    await storeProvider(providerRow("a"))
    mountTranslationProvider()
    openTranslationByShortcut()

    expect(await screen.findByText("translated by the provider")).toBeInTheDocument()

    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
    expect(mocks.translateTextCore).not.toHaveBeenCalled()
  })

  it("uses only version A when the row is edited to version B while the request is still on its way", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    mountTranslationProvider()
    openTranslationByShortcut()
    await waitFor(() => expect(bridge.pending).toBe(1))

    // The same row, edited in Settings: new endpoint, key, header, model, temperature and options.
    await storeProvider(providerRow("b"))
    await act(async () => {
      bridge.release()
    })

    expect(await screen.findByText("translated by the provider")).toBeInTheDocument()
    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("still runs on version A when the row is deleted before the background looks at it", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    mountTranslationProvider()
    openTranslationByShortcut()
    await waitFor(() => expect(bridge.pending).toBe(1))

    await storeProvider(null)
    await act(async () => {
      bridge.release()
    })

    expect(await screen.findByText("translated by the provider")).toBeInTheDocument()
    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("sends nothing to the provider when the popover is closed before the background saw the request", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    mountTranslationProvider()
    openTranslationByShortcut()
    await waitFor(() => expect(bridge.pending).toBe(1))

    fireEvent.click(screen.getByRole("button", { name: "close" }))
    await act(async () => {
      bridge.release()
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(transport.requests).toHaveLength(0)
  })
})
