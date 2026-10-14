// @vitest-environment jsdom
import type { ReactNode, Ref } from "react"
import type { Config } from "@/types/config/config"
import type { ProvidersConfig } from "@/types/config/provider"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { ANALYTICS_SURFACE } from "@/types/analytics"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  BUILT_IN_DICTIONARY_ACTION_ID,
  BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID,
} from "@/utils/constants/custom-action"
import { findSelectionToolbarAction, patchSelectionToolbarAction } from "@/utils/custom-actions"
import { SelectionCustomActionProvider } from "../custom-action-button/provider"
import { SelectionTranslationProvider } from "../translate-button/provider"

// What the two providers reach out to is replaced; everything that decides "is there a usable
// provider" is real: the selection atoms, resolveProviderRefForCapability, the plan builder,
// the inline-error helper and the alert (so the button really is pressed).
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
  trackFeatureUsed: vi.fn<(...args: any[]) => any>(),
  streamBackgroundText: vi.fn<(...args: any[]) => any>(),
  streamBackgroundStructuredObject: vi.fn<(...args: any[]) => any>(),
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

// Requests: reaching any of these means the popover tried to translate / run the action.
vi.mock("@/utils/content-script/background-stream-client", () => ({
  streamBackgroundText: mocks.streamBackgroundText,
  streamBackgroundStructuredObject: mocks.streamBackgroundStructuredObject,
}))
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

const SETTINGS_BUTTON = { name: "providerRequired.openSettings" }

const ENABLED = {
  id: "test-openai",
  name: "Test OpenAI",
  provider: "openai",
  enabled: true,
  apiKey: "test-key",
  model: { model: "gpt-4o-mini", isCustomModel: false, customModel: null },
} satisfies ProvidersConfig[number]
const DISABLED = { ...ENABLED, id: "disabled-openai", name: "Disabled OpenAI", enabled: false }
// Always in the list, so every "unusable" case below also shows that a working provider elsewhere
// is never borrowed for a feature that was not given one.
const PROVIDERS: ProvidersConfig = [ENABLED, DISABLED]

const UNUSABLE = [
  ["not chosen", ""],
  ["deleted", "deleted-openai"],
  ["disabled", DISABLED.id],
] as const

function optionsUrl(rowId: string) {
  const params = new URLSearchParams({ section: rowId }).toString()
  return `chrome-extension://test/options.html#/api-providers?${params}`
}

function translationConfig(providerId: string): Config {
  const { selectionToolbar } = DEFAULT_CONFIG
  return {
    ...DEFAULT_CONFIG,
    providersConfig: PROVIDERS,
    selectionToolbar: {
      ...selectionToolbar,
      features: {
        ...selectionToolbar.features,
        translate: { ...selectionToolbar.features.translate, providerId },
      },
    },
  }
}

/** The dictionary action is the one under test; sentence analysis keeps a working provider. */
function actionConfig(providerId: string): Config {
  const selectionToolbar = patchSelectionToolbarAction(
    patchSelectionToolbarAction(DEFAULT_CONFIG.selectionToolbar, BUILT_IN_DICTIONARY_ACTION_ID, {
      providerId,
    }),
    BUILT_IN_SENTENCE_ANALYSIS_ACTION_ID,
    { providerId: ENABLED.id },
  )
  const action = findSelectionToolbarAction(selectionToolbar, BUILT_IN_DICTIONARY_ACTION_ID)
  expect(action?.providerId).toBe(providerId)
  expect(action?.enabled).not.toBe(false)
  return { ...DEFAULT_CONFIG, providersConfig: PROVIDERS, selectionToolbar }
}

function mount(
  provider: typeof SelectionTranslationProvider | typeof SelectionCustomActionProvider,
  config: Config,
) {
  const store = createStore()
  store.set(configAtom, config)
  render(createElement(Provider, { store }, createElement(provider, null, null)))
}

function registeredShortcutHandler() {
  if (!mocks.shortcutHandler) {
    throw new Error("the provider did not register a selection shortcut handler")
  }
  return mocks.shortcutHandler
}

function registeredListener(type: string) {
  const listener = mocks.messageListeners.get(type)
  if (!listener) {
    throw new Error(`the provider did not listen for ${type}`)
  }
  return listener
}

function openTranslationByShortcut() {
  act(() => {
    registeredShortcutHandler()("translate", mocks.session)
  })
}

function openTranslationFromContextMenu() {
  act(() => {
    registeredListener("openSelectionTranslationFromContextMenu")({ data: undefined })
  })
}

function openActionByShortcut() {
  act(() => {
    registeredShortcutHandler()(BUILT_IN_DICTIONARY_ACTION_ID, mocks.session)
  })
}

function openActionFromContextMenu() {
  act(() => {
    registeredListener("openSelectionCustomActionFromContextMenu")({
      data: { actionId: BUILT_IN_DICTIONARY_ACTION_ID },
    })
  })
}

const TRANSLATION_ENTRIES = [
  ["shortcut", ANALYTICS_SURFACE.SHORTCUT, openTranslationByShortcut],
  ["context menu", ANALYTICS_SURFACE.CONTEXT_MENU, openTranslationFromContextMenu],
] as const

const ACTION_ENTRIES = [
  ["shortcut", ANALYTICS_SURFACE.SHORTCUT, openActionByShortcut],
  ["context menu", ANALYTICS_SURFACE.CONTEXT_MENU, openActionFromContextMenu],
] as const

/** The message is shown, nothing opens by itself, and pressing the button opens exactly the row. */
async function expectSettingsButtonOpens(rowId: string) {
  const button = await screen.findByRole("button", SETTINGS_BUTTON)
  expect(screen.getByText("providerRequired.message")).toBeInTheDocument()
  expect(mocks.sendMessage).not.toHaveBeenCalled()

  fireEvent.click(button)

  expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
  expect(mocks.sendMessage).toHaveBeenCalledWith("openPage", {
    url: optionsUrl(rowId),
    active: true,
  })
}

// Stands in for the extension origin the options page lives on.
const runtime = browser.runtime as unknown as { getURL: (path: string) => string }
const realGetURL = runtime.getURL

beforeEach(() => {
  runtime.getURL = (path) => `chrome-extension://test${path}`
  mocks.streamBackgroundText.mockResolvedValue({
    output: "translated text",
    thinking: { status: "complete", text: "" },
  })
  mocks.streamBackgroundStructuredObject.mockResolvedValue({
    output: { result: "action result" },
    thinking: { status: "complete", text: "" },
  })
})

afterEach(() => {
  cleanup()
  runtime.getURL = realGetURL
  mocks.shortcutHandler = undefined
  mocks.messageListeners.clear()
  vi.clearAllMocks()
})

describe("selection translation without a usable provider", () => {
  describe.each(UNUSABLE)("when the provider is %s", (_label, providerId) => {
    it.each(TRANSLATION_ENTRIES)(
      "opened from the %s links to its settings row instead of translating",
      async (_name, surface, open) => {
        mount(SelectionTranslationProvider, translationConfig(providerId))
        open()

        await expectSettingsButtonOpens("feature-provider-selectionTranslation")

        expect(mocks.streamBackgroundText).not.toHaveBeenCalled()
        expect(mocks.translateTextCore).not.toHaveBeenCalled()
        expect(mocks.trackFeatureUsed).toHaveBeenCalledTimes(1)
        expect(mocks.trackFeatureUsed).toHaveBeenCalledWith(
          expect.objectContaining({
            feature: "selection_translation",
            surface,
            outcome: "failure",
            failure_reason: "precheck",
          }),
        )
      },
    )
  })

  it("asks again on Regenerate without sending a request", async () => {
    mount(SelectionTranslationProvider, translationConfig(""))
    openTranslationByShortcut()
    await screen.findByRole("button", SETTINGS_BUTTON)

    fireEvent.click(screen.getByRole("button", { name: "regenerate" }))

    expect(screen.getByRole("button", SETTINGS_BUTTON)).toBeInTheDocument()
    // One precheck failure per attempt, and still nothing was requested.
    expect(mocks.trackFeatureUsed).toHaveBeenCalledTimes(2)
    expect(mocks.streamBackgroundText).not.toHaveBeenCalled()
    expect(mocks.translateTextCore).not.toHaveBeenCalled()
  })

  it("clears the message when closed and asks again on the next open", async () => {
    mount(SelectionTranslationProvider, translationConfig(""))
    openTranslationByShortcut()
    await screen.findByRole("button", SETTINGS_BUTTON)

    fireEvent.click(screen.getByRole("button", { name: "close" }))
    expect(screen.queryByRole("button", SETTINGS_BUTTON)).not.toBeInTheDocument()

    openTranslationByShortcut()
    expect(await screen.findByRole("button", SETTINGS_BUTTON)).toBeInTheDocument()
    expect(mocks.streamBackgroundText).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("translates without any call to action when the provider is usable", async () => {
    mount(SelectionTranslationProvider, translationConfig(ENABLED.id))
    openTranslationByShortcut()

    expect(await screen.findByText("translated text")).toBeInTheDocument()
    expect(mocks.streamBackgroundText).toHaveBeenCalledTimes(1)
    expect(mocks.streamBackgroundText).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: ENABLED.id, usageFeature: "selectionTranslation" }),
      expect.anything(),
    )
    expect(screen.queryByRole("button", SETTINGS_BUTTON)).not.toBeInTheDocument()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
})

describe("custom action without a usable provider", () => {
  describe.each(UNUSABLE)("when the provider is %s", (_label, providerId) => {
    it.each(ACTION_ENTRIES)(
      "opened from the %s links to that action's own row instead of running",
      async (_name, surface, open) => {
        mount(SelectionCustomActionProvider, actionConfig(providerId))
        open()

        // The row is the dictionary's, not the sentence analysis action that does have a provider.
        await expectSettingsButtonOpens(`feature-provider-action-${BUILT_IN_DICTIONARY_ACTION_ID}`)

        expect(mocks.streamBackgroundStructuredObject).not.toHaveBeenCalled()
        expect(mocks.trackFeatureUsed).toHaveBeenCalledTimes(1)
        expect(mocks.trackFeatureUsed).toHaveBeenCalledWith(
          expect.objectContaining({
            feature: "custom_ai_action",
            surface,
            action_id: BUILT_IN_DICTIONARY_ACTION_ID,
            outcome: "failure",
            failure_reason: "precheck",
          }),
        )
      },
    )
  })

  it("runs the action without any call to action when its provider is usable", async () => {
    mount(SelectionCustomActionProvider, actionConfig(ENABLED.id))
    openActionByShortcut()

    await waitFor(() => expect(mocks.streamBackgroundStructuredObject).toHaveBeenCalledTimes(1))
    expect(mocks.streamBackgroundStructuredObject).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: ENABLED.id }),
      expect.anything(),
    )
    expect(screen.queryByRole("button", SETTINGS_BUTTON)).not.toBeInTheDocument()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
})
