// @vitest-environment jsdom
// Escape closes the selection translation popover wherever focus is inside it.
//
// A press on one of the popover's icon buttons (Regenerate, Copy, context details) leaves that
// button's hint tooltip open, and the button keeps focus. Base UI's tooltip handles Escape on its
// trigger and stops the event from propagating, so the event never reaches the document, where
// the popover listens: the first Escape only hid the hint and the popover (and the run it was
// showing) stayed.
//
// Real: SelectionTranslationProvider (its run lifecycle and cancellation), the real popover
// (SelectionPopover on Base UI's Dialog), the real footer with its Regenerate and context-details
// buttons and their tooltips, the real Close and Pin buttons, the real CopyButton, and Base UI's
// own keyboard dismissal. The popover is mounted inside an open shadow root, as in the page, so
// key events are retargeted at the host. Replaced: the provider edge (streamBackgroundText, a
// promise the test controls), the config atom, and the pieces that only decide how a selection
// opens a session. Production code in tests: jsdom, no browser.

import type { Config } from "@/types/config/config"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { createElement, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { SelectionPopover } from "@/components/ui/selection-popover"
import { CopyButton } from "@/components/ui/selection-popover/copy-button"
import { SelectionToolbarTooltip } from "@/components/ui/selection-popover/selection-tooltip"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { ShadowWrapperContext } from "@/utils/react-shadow-host/create-shadow-host"
import { SelectionTranslationProvider } from "../translate-button/provider"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
  trackFeatureUsed: vi.fn<(...args: any[]) => any>(),
  streamBackgroundText: vi.fn<(...args: any[]) => any>(),
  // The shadow-root wrapper the popover portals into, as the content script provides it.
  shadowWrapper: undefined as HTMLElement | undefined,
  // The newest handler the provider registered with useSelectionShortcuts.
  shortcutHandler: undefined as ((id: string, session: unknown) => boolean) | undefined,
  session: {
    id: 1,
    createdAt: 0,
    selectionSnapshot: { text: "Hello world" },
    contextSnapshot: { text: "Hello world, hello.", paragraphs: [] as string[] },
  },
}))

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
  onMessage: () => () => {},
}))
vi.mock("@/utils/analytics", async () => ({
  ...(await vi.importActual<typeof import("@/utils/analytics")>("@/utils/analytics")),
  trackFeatureUsed: mocks.trackFeatureUsed,
}))
vi.mock("@/utils/content-script/background-stream-client", () => ({
  streamBackgroundText: mocks.streamBackgroundText,
  streamBackgroundStructuredObject: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/host/translate/translate-text", () => ({
  translateTextCore: vi.fn<(...args: any[]) => any>(),
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
// Icons are fetched through the background; they play no part in keyboard handling.
vi.mock("@iconify/react", () => ({ Icon: () => null }))

// The content script entry owns the shadow root the popover portals into.
vi.mock("../..", () => ({
  get shadowWrapper() {
    return mocks.shadowWrapper
  },
}))
// The answer's rendering, the note card and the target-language menu have no part in it.
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
vi.mock("../use-selection-open-request", () => {
  const anchor = { x: 40, y: 60 }
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
// The provider list menu is a Base UI Select with its own portal; a plain button stands in.
vi.mock("@/components/llm-providers/provider-selector", async () => {
  const { createElement: h } = await import("react")
  return { default: () => h("button", { type: "button", "data-testid": "provider-selector" }, "p") }
})
vi.mock("../translate-button/target-language-selector", async () => {
  const { createElement: h } = await import("react")
  return {
    TargetLanguageSelector: () =>
      h("button", { type: "button", "data-testid": "target-language" }, "Target Language"),
  }
})

const PROVIDER_ID = "openai-default"

function selectionConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    providersConfig: [{ ...DEFAULT_PROVIDER_CONFIG.openai, apiKey: "test-key" }],
    selectionToolbar: {
      ...DEFAULT_CONFIG.selectionToolbar,
      features: {
        ...DEFAULT_CONFIG.selectionToolbar.features,
        translate: {
          ...DEFAULT_CONFIG.selectionToolbar.features.translate,
          providerId: PROVIDER_ID,
        },
      },
    },
  }
}

interface StreamRun {
  signal: AbortSignal
  onChunk: (data: { output: string; thinking: null }) => void
  finish: (output: string) => void
}
let runs: StreamRun[]

/** A provider that streams until told to finish and gives up when its request is aborted. */
function installStreamingProvider() {
  mocks.streamBackgroundText.mockImplementation(
    (_payload: unknown, options: { signal: AbortSignal; onChunk: StreamRun["onChunk"] }) =>
      new Promise((resolve, reject) => {
        const run: StreamRun = {
          signal: options.signal,
          onChunk: options.onChunk,
          finish: (output) => resolve({ output, thinking: null }),
        }
        runs.push(run)
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        )
      }),
  )
}

let host: HTMLElement
let wrapper: HTMLElement

/** An open shadow root on the page, with the wrapper the popover portals into. */
function createShadowRoot() {
  host = document.createElement("div")
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  wrapper = document.createElement("div")
  shadow.append(wrapper)
  mocks.shadowWrapper = wrapper
}

function mountInShadowRoot() {
  createShadowRoot()

  const store = createStore()
  store.set(configAtom, selectionConfig())
  render(
    createElement(
      Provider,
      { store },
      createElement(TooltipProvider, null, createElement(SelectionTranslationProvider, null, null)),
    ),
    { container: wrapper },
  )
}

function openTranslation() {
  const handler = mocks.shortcutHandler
  if (!handler) throw new Error("the provider did not register a shortcut handler")
  act(() => {
    handler("translate", mocks.session)
  })
}

const inShadow = () => within(wrapper)
const popoverIsOpen = () => inShadow().queryByRole("button", { name: "Close" }) !== null

/** Escape as the browser delivers it: on the focused element, bubbling out of the shadow root. */
function pressEscape(target: Element) {
  act(() => {
    fireEvent.keyDown(target, { key: "Escape", code: "Escape", bubbles: true, composed: true })
  })
}

function focus(element: HTMLElement) {
  act(() => {
    element.focus()
  })
}

/** The viewer's click: press, focus the button (a mouse click does), then click. */
function clickAndFocus(element: HTMLElement) {
  act(() => {
    fireEvent.pointerDown(element)
    element.focus()
    fireEvent.click(element)
  })
}

beforeEach(() => {
  runs = []
  installStreamingProvider()
})

afterEach(() => {
  cleanup()
  host?.remove()
  mocks.shadowWrapper = undefined
  mocks.shortcutHandler = undefined
  vi.clearAllMocks()
})

async function openAndAnswer(answer = "translated") {
  mountInShadowRoot()
  openTranslation()
  await waitFor(() => expect(runs).toHaveLength(1))
  act(() => runs[0]!.finish(answer))
  await inShadow().findByText(answer)
}

/** The element that has focus inside the shadow root, as the browser would deliver a key to it. */
const focused = () => host.shadowRoot!.activeElement as HTMLElement

describe("escape closes the selection translation popover", () => {
  describe("positive controls: what must not change", () => {
    it("closes from the first control while the answer is still streaming, and cancels the run", async () => {
      mountInShadowRoot()
      openTranslation()
      await waitFor(() => expect(runs).toHaveLength(1))
      const control = inShadow().getByTestId("target-language")
      focus(control)

      pressEscape(control)

      expect(popoverIsOpen()).toBe(false)
      expect(runs[0]!.signal.aborted).toBe(true)
    })

    it("closes from the first control once the answer is shown", async () => {
      await openAndAnswer()
      const control = inShadow().getByTestId("target-language")
      focus(control)

      pressEscape(control)

      expect(popoverIsOpen()).toBe(false)
    })

    it("closes with focus on the popover itself while streaming (nothing inside is focused)", async () => {
      mountInShadowRoot()
      openTranslation()
      await waitFor(() => expect(runs).toHaveLength(1))

      pressEscape(inShadow().getByRole("button", { name: "Close" }))

      expect(popoverIsOpen()).toBe(false)
      expect(runs[0]!.signal.aborted).toBe(true)
    })

    it("the Close button closes it and cancels the run", async () => {
      mountInShadowRoot()
      openTranslation()
      await waitFor(() => expect(runs).toHaveLength(1))

      clickAndFocus(inShadow().getByRole("button", { name: "Close" }))

      expect(popoverIsOpen()).toBe(false)
      expect(runs[0]!.signal.aborted).toBe(true)
    })

    it("an open interactive layer takes the first Escape and the popover the second", async () => {
      await openAndAnswer()
      clickAndFocus(inShadow().getByRole("button", { name: "action.viewContextDetails" }))
      await waitFor(() =>
        expect(inShadow().queryByText("action.contextDetailsTitleLabel")).not.toBeNull(),
      )

      pressEscape(focused())
      await waitFor(() =>
        expect(inShadow().queryByText("action.contextDetailsTitleLabel")).toBeNull(),
      )
      expect(popoverIsOpen()).toBe(true)

      pressEscape(focused() ?? inShadow().getByRole("button", { name: "Close" }))
      expect(popoverIsOpen()).toBe(false)
    })
  })

  describe("while an icon button's hint tooltip is open", () => {
    it("Escape closes the popover and cancels the run Regenerate started", async () => {
      await openAndAnswer()
      const regenerate = inShadow().getByRole("button", { name: "action.regenerate" })
      clickAndFocus(regenerate)
      await waitFor(() => expect(runs).toHaveLength(2))
      expect(focused()).toBe(regenerate)
      expect(wrapper.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1)

      pressEscape(regenerate)

      expect(popoverIsOpen()).toBe(false)
      expect(runs[1]!.signal.aborted).toBe(true)
      expect(mocks.streamBackgroundText).toHaveBeenCalledTimes(2)
    })

    it("one Escape is enough: the hint goes with the popover", async () => {
      await openAndAnswer()
      const regenerate = inShadow().getByRole("button", { name: "action.regenerate" })
      clickAndFocus(regenerate)
      await waitFor(() => expect(runs).toHaveLength(2))

      pressEscape(regenerate)

      expect(popoverIsOpen()).toBe(false)
      expect(wrapper.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(0)
    })

    it("a finished regenerated answer closes the same way", async () => {
      await openAndAnswer()
      const regenerate = inShadow().getByRole("button", { name: "action.regenerate" })
      clickAndFocus(regenerate)
      await waitFor(() => expect(runs).toHaveLength(2))
      act(() => runs[1]!.finish("second answer"))
      await inShadow().findByText("second answer")

      pressEscape(regenerate)

      expect(popoverIsOpen()).toBe(false)
    })

    it("keyboard only: a button focused with Tab shows its hint, and Escape closes the popover", async () => {
      await openAndAnswer()
      const regenerate = inShadow().getByRole("button", { name: "action.regenerate" })

      focus(regenerate)
      expect(wrapper.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1)
      pressEscape(regenerate)

      expect(popoverIsOpen()).toBe(false)
    })

    it("the Copy button's confirmation tooltip does not hold the popover open either", async () => {
      function Harness() {
        const [open, setOpen] = useState(true)
        return (
          <TooltipProvider>
            <SelectionPopover.Root open={open} onOpenChange={setOpen} anchor={{ x: 10, y: 10 }}>
              <SelectionPopover.Content container={wrapper} finalFocus={false}>
                <SelectionPopover.Header>
                  <SelectionPopover.Title>Copy test</SelectionPopover.Title>
                  <SelectionPopover.Close />
                </SelectionPopover.Header>
                <SelectionPopover.Body>
                  <CopyButton text="copied text" />
                </SelectionPopover.Body>
              </SelectionPopover.Content>
            </SelectionPopover.Root>
          </TooltipProvider>
        )
      }
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined) },
      })
      createShadowRoot()
      render(createElement(Harness), { container: wrapper })
      const copyButton = wrapper.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!
      clickAndFocus(copyButton)
      expect(wrapper.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1)

      pressEscape(copyButton)

      expect(popoverIsOpen()).toBe(false)
    })
  })

  describe("the change stays inside the popover", () => {
    it("focus goes back to the trigger when Escape closes the popover (focus restoration)", async () => {
      createShadowRoot()
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            SelectionPopover.Root,
            null,
            createElement(SelectionPopover.Trigger, null, "Open popover"),
            createElement(
              SelectionPopover.Content,
              { container: wrapper },
              createElement(
                SelectionPopover.Header,
                null,
                createElement(SelectionPopover.Title, null, "Restore test"),
                createElement(SelectionPopover.Close, null),
              ),
              createElement(SelectionPopover.Body, null, "body"),
            ),
          ),
        ),
        { container: wrapper },
      )
      const trigger = inShadow().getByRole("button", { name: "Open popover" })
      clickAndFocus(trigger)
      await waitFor(() => expect(popoverIsOpen()).toBe(true))

      pressEscape(inShadow().getByRole("button", { name: "Close" }))

      await waitFor(() => expect(popoverIsOpen()).toBe(false))
      await waitFor(() => expect(focused()).toBe(trigger))
    })

    it("a hint on the page's own selection toolbar still keeps its Escape (nothing reaches the page)", () => {
      createShadowRoot()
      const pageListener = vi.fn<(...args: any[]) => any>()
      document.addEventListener("keydown", pageListener)
      render(
        createElement(
          ShadowWrapperContext,
          { value: wrapper },
          createElement(
            TooltipProvider,
            null,
            createElement(SelectionToolbarTooltip, {
              content: "Toolbar hint",
              render: createElement("button", { type: "button" }, "tool"),
            }),
          ),
        ),
        { container: wrapper },
      )
      const tool = inShadow().getByRole("button", { name: "tool" })
      focus(tool)
      expect(wrapper.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1)

      pressEscape(tool)

      expect(wrapper.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(0)
      expect(pageListener).not.toHaveBeenCalled()
      document.removeEventListener("keydown", pageListener)
    })
  })
})
