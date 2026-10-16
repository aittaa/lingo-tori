import type {
  FakeChromeSidePanel,
  SidePanelLevel,
} from "@/entrypoints/background/__tests__/fake-side-panel"
// @vitest-environment jsdom
import type { FloatingButtonConfig } from "@/types/config/floating-button"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { atom, createStore, Provider } from "jotai"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createFakeChromeSidePanel } from "@/entrypoints/background/__tests__/fake-side-panel"
import { setupSidePanelMessageHandler } from "@/entrypoints/background/side-panel"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { sendMessage } from "@/utils/message"
import FloatingButton from ".."
import { enablePageTranslationAtom } from "../../../atoms"

const toastAddMock = vi.fn<(...args: any[]) => any>()

vi.mock("#imports", () => ({
  browser: {
    runtime: {
      getURL: (path = "") => `chrome-extension://test-extension${path}`,
      getManifest: () => ({ version: "1.43.3" }),
    },
  },
  i18n: {
    t: (key: string) => key,
  },
}))

vi.mock("@/utils/atoms/config", () => {
  const floatingButtonBaseAtom = atom<FloatingButtonConfig>({
    enabled: true,
    position: 0.66,
    side: "right",
    clickAction: "panel",
    disabledFloatingButtonPatterns: [],
    locked: false,
  })
  const floatingButtonAtom = atom(
    (get) => get(floatingButtonBaseAtom),
    (get, set, patch: Partial<FloatingButtonConfig>) => {
      set(floatingButtonBaseAtom, {
        ...get(floatingButtonBaseAtom),
        ...patch,
      })
    },
  )

  return {
    configFieldsAtomMap: {
      floatingButton: floatingButtonAtom,
      sideContent: atom({ width: 360 }),
      uiLanguage: atom("en"),
    },
  }
})

vi.mock("../../../atoms", () => ({
  enablePageTranslationAtom: atom({ enabled: false }),
  isDraggingButtonAtom: atom(false),
  isSideOpenAtom: atom(false),
}))

vi.mock("../../../index", () => ({
  shadowWrapper: document.body,
}))

vi.mock("@/utils/message", () => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/i18n/locale-map", () => ({
  resolveUiLocale: (uiLanguage: string) => (uiLanguage === "auto" ? "en" : uiLanguage),
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  anchoredToastManager: {
    add: (...args: unknown[]) => toastAddMock(...args),
  },
}))

beforeAll(() => {
  vi.stubEnv("BROWSER", "chrome")

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(sendMessage).mockReset()
  toastAddMock.mockReset()
  window.history.replaceState({}, "", "/")
  setViewport(1024, 768)
})

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  })
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  })
}

function renderFloatingButton(floatingButtonOverrides: Partial<FloatingButtonConfig> = {}) {
  const store = createStore()
  void store.set(configFieldsAtomMap.floatingButton, floatingButtonOverrides)

  return {
    store,
    ...render(
      <Provider store={store}>
        <FloatingButton />
      </Provider>,
    ),
  }
}

function getMainButton() {
  return screen.getByTestId("floating-main-button")
}

function getFloatingButtonConfig(store: ReturnType<typeof createStore>) {
  return store.get(configFieldsAtomMap.floatingButton)
}

function mockRect(element: Element, rect: Partial<DOMRect>) {
  const left = rect.left ?? 0
  const top = rect.top ?? 0
  const width = rect.width ?? 0
  const height = rect.height ?? 0
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: rect.right ?? left + width,
    bottom: rect.bottom ?? top + height,
    toJSON: () => {},
  })
}

const TOOLTIP_CONTROL_LABELS = [
  "options.floatingButton.tooltips.togglePageTranslation",
  "options.floatingButton.tooltips.settings",
  "options.floatingButton.tooltips.feedback",
] as const

async function expectTooltipSide(label: string, side: "left" | "right") {
  const trigger = screen.getByRole("button", { name: label })
  fireEvent.focus(trigger)

  await waitFor(() => {
    const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-content"][data-open]')
    expect(popup).toHaveTextContent(label)
    expect(popup).toHaveAttribute("data-side", side)
    expect(popup).toHaveClass("pointer-events-none")
    expect(popup?.parentElement).toHaveClass("pointer-events-none")
  })

  fireEvent.blur(trigger)
  await waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull()
  })
}

describe("floatingButton controls", () => {
  it("shows the close trigger only after entering the main floating button", () => {
    renderFloatingButton()

    const closeTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.floatingButtonOptions",
    })
    const mainButton = getMainButton()

    expect(mainButton).toHaveClass("transition-transform")
    expect(mainButton).toHaveClass("duration-300")
    expect(closeTrigger).toHaveClass("-top-1")
    expect(closeTrigger).toHaveClass("left-0")
    expect(closeTrigger).toHaveClass("invisible")
    expect(closeTrigger).toHaveClass("pointer-events-none")
    expect(closeTrigger).toHaveClass("text-neutral-300")
    expect(closeTrigger).toHaveClass("hover:scale-110")
    expect(closeTrigger).toHaveClass("active:scale-90")
    expect(closeTrigger).toHaveClass("hover:text-neutral-500")
    expect(closeTrigger).toHaveClass("active:text-neutral-500")

    fireEvent.mouseEnter(mainButton)

    expect(closeTrigger).toHaveClass("visible")
    expect(closeTrigger).toHaveClass("pointer-events-auto")
    expect(closeTrigger).toHaveClass("-left-6")
  })

  it("renders a lock trigger at the lower-left corner and keeps controls expanded after entering the main button", () => {
    renderFloatingButton()

    const lockTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.lockPosition",
    })
    const mainButton = getMainButton()
    const floatingButtonContainer = screen.getByTestId("floating-button-container")

    expect(lockTrigger).toHaveClass("left-0")
    expect(lockTrigger).toHaveClass("-bottom-1")
    expect(lockTrigger).toHaveClass("invisible")
    expect(lockTrigger).toHaveClass("pointer-events-none")
    expect(lockTrigger).toHaveClass("text-neutral-300")
    expect(lockTrigger).toHaveClass("hover:scale-110")
    expect(lockTrigger).toHaveClass("active:scale-90")
    expect(lockTrigger).toHaveClass("hover:text-neutral-500")
    expect(lockTrigger).toHaveClass("active:text-neutral-500")
    expect(mainButton).toHaveClass("translate-x-6")

    fireEvent.mouseEnter(mainButton)

    expect(lockTrigger).toHaveClass("visible")
    expect(lockTrigger).toHaveClass("pointer-events-auto")
    expect(lockTrigger).toHaveClass("-left-6")
    expect(mainButton).toHaveClass("translate-x-0")

    fireEvent.click(lockTrigger)

    const unlockTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.unlockPosition",
    })

    expect(unlockTrigger).toHaveClass("text-neutral-300")
    expect(unlockTrigger).toHaveClass("-left-6")
    expect(mainButton).toHaveClass("translate-x-0")
    expect(mainButton).toHaveClass("opacity-100")
    expect(mainButton).not.toHaveClass("translate-x-6")

    fireEvent.mouseLeave(floatingButtonContainer)

    expect(mainButton).toHaveClass("translate-x-0")
    expect(mainButton).toHaveClass("opacity-60")

    fireEvent.mouseEnter(mainButton)

    expect(mainButton).toHaveClass("opacity-100")
  })

  it("does not show a tooltip for options and keeps its trigger visible while the dropdown is open", () => {
    renderFloatingButton()

    const closeTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.floatingButtonOptions",
    })
    const mainButton = getMainButton()

    fireEvent.mouseEnter(mainButton)
    fireEvent.focus(closeTrigger)
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull()
    fireEvent.click(closeTrigger)

    expect(closeTrigger).toHaveClass("visible")
    expect(closeTrigger).toHaveClass("pointer-events-auto")
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull()
    expect(screen.getByText("options.floatingButton.closeMenu.disableForSite")).toBeInTheDocument()
  })

  it("does not show a tooltip for the lock control", () => {
    renderFloatingButton()
    fireEvent.mouseEnter(getMainButton())

    const lockTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.lockPosition",
    })
    fireEvent.focus(lockTrigger)

    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull()
  })

  it.each([
    { floatingSide: "right", tooltipSide: "left" },
    { floatingSide: "left", tooltipSide: "right" },
  ] as const)(
    "opens each directional tooltip on the $tooltipSide when docked to the $floatingSide",
    async ({ floatingSide, tooltipSide }) => {
      renderFloatingButton({ side: floatingSide })
      fireEvent.mouseEnter(getMainButton())
      expect(TOOLTIP_CONTROL_LABELS).toHaveLength(3)

      for (const label of TOOLTIP_CONTROL_LABELS) {
        await expectTooltipSide(label, tooltipSide)
      }
    },
  )

  it("toggles the browser side panel on a normal panel click", () => {
    vi.useFakeTimers()
    renderFloatingButton({ clickAction: "panel" })

    const mainButton = getMainButton()

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    vi.advanceTimersByTime(349)
    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })

    expect(sendMessage).toHaveBeenCalledWith("toggleSidePanel", undefined)
  })

  it("places feedback after settings and opens the project issue tracker without page metadata", () => {
    window.history.replaceState({}, "", "/private/path?token=secret#section")
    renderFloatingButton()

    const settingsButton = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.settings",
    })
    const feedbackButton = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.feedback",
    })

    expect(
      settingsButton.compareDocumentPosition(feedbackButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    fireEvent.click(feedbackButton)

    const openPageCall = vi
      .mocked(sendMessage)
      .mock.calls.find(([message]) => message === "openPage")
    const openPagePayload = openPageCall?.[1] as { active: boolean; url: string } | undefined
    expect(openPagePayload).toBeDefined()
    const openedUrl = new URL(openPagePayload!.url)

    expect(openedUrl.origin).toBe("https://github.com")
    expect(openedUrl.pathname).toContain("/issues")
    expect(openedUrl.search).toBe("")
    expect(openPagePayload).toEqual({
      url: openedUrl.toString(),
      active: true,
    })
  })

  it("shows a Firefox sidebar help link when the browser requires an extension user action", async () => {
    vi.useFakeTimers()
    vi.mocked(sendMessage).mockResolvedValue({
      ok: false,
      reason: "requires-extension-user-action",
    })
    renderFloatingButton({ clickAction: "panel" })

    const mainButton = getMainButton()

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    vi.advanceTimersByTime(349)
    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(toastAddMock).toHaveBeenCalledWith({
      id: "firefox-sidebar-user-action",
      positionerProps: {
        anchor: mainButton,
        side: "left",
        sideOffset: 8,
      },
      type: "info",
      title: expect.anything(),
    })

    const toastContent = toastAddMock.mock.calls[0]?.[0]?.title
    expect(toastContent).toBeDefined()
    render(<>{toastContent}</>)

    expect(screen.getByText("sidePanel.firefoxUserActionHint")).toBeInTheDocument()
    const link = screen.getByRole("link", { name: "sidePanel.firefoxUserActionHelpText" })
    expect(link).toHaveAttribute("href", "sidePanel.firefoxUserActionHelpUrl")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("places Firefox sidebar help to the right of a left-side floating button", async () => {
    vi.useFakeTimers()
    vi.mocked(sendMessage).mockResolvedValue({
      ok: false,
      reason: "requires-extension-user-action",
    })
    renderFloatingButton({ clickAction: "panel", side: "left" })

    const mainButton = getMainButton()

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 20,
      clientY: 500,
    })
    vi.advanceTimersByTime(349)
    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 20,
      clientY: 500,
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        positionerProps: {
          anchor: mainButton,
          side: "right",
          sideOffset: 8,
        },
      }),
    )
  })

  it("keeps translate as a normal click action", () => {
    vi.useFakeTimers()
    renderFloatingButton({ clickAction: "translate" })

    const mainButton = getMainButton()

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    vi.advanceTimersByTime(349)
    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })

    expect(sendMessage).toHaveBeenCalledWith(
      "tryToSetEnablePageTranslationOnContentScript",
      expect.objectContaining({ enabled: true }),
    )
  })

  it("starts page translation from the hidden translate button as a floating-button start", () => {
    renderFloatingButton()

    fireEvent.click(
      screen.getByRole("button", { name: "options.floatingButton.tooltips.togglePageTranslation" }),
    )

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith("tryToSetEnablePageTranslationOnContentScript", {
      enabled: true,
      analyticsContext: expect.objectContaining({
        feature: "page_translation",
        surface: "floating_button",
        startedAt: expect.any(Number),
      }),
    })
  })

  it("stops page translation from the hidden translate button with no provider and no context", () => {
    // The mocked config has no provider for any feature: stopping must not depend on one.
    const { store } = renderFloatingButton()
    act(() => {
      store.set(enablePageTranslationAtom, { enabled: true })
    })

    fireEvent.click(
      screen.getByRole("button", { name: "options.floatingButton.tooltips.togglePageTranslation" }),
    )

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith("tryToSetEnablePageTranslationOnContentScript", {
      enabled: false,
    })
    expect(sendMessage).toHaveBeenCalledWith(
      "tryToSetEnablePageTranslationOnContentScript",
      expect.not.objectContaining({ analyticsContext: expect.anything() }),
    )
  })

  it("turns the frog into the only visible control after a long press", () => {
    vi.useFakeTimers()
    renderFloatingButton()

    const mainButton = getMainButton()
    expect(screen.getAllByRole("button")).toHaveLength(5)

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    act(() => {
      vi.advanceTimersByTime(350)
    })

    expect(mainButton).toHaveClass("rounded-full")
    expect(screen.queryAllByRole("button")).toHaveLength(0)

    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("starts dragging before the long-press delay after enough pointer movement", () => {
    vi.useFakeTimers()
    renderFloatingButton()

    const mainButton = getMainButton()

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 500,
    })
    fireEvent.pointerMove(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 908,
      clientY: 500,
    })

    expect(mainButton).toHaveClass("rounded-full")
    expect(screen.queryAllByRole("button")).toHaveLength(0)

    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 908,
      clientY: 500,
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("persists the left side and vertical position after dragging to the left half", () => {
    vi.useFakeTimers()
    setViewport(1000, 1000)
    const { store } = renderFloatingButton({ position: 0.6, side: "right" })

    const mainButton = getMainButton()
    const floatingButtonContainer = screen.getByTestId("floating-button-container")
    mockRect(floatingButtonContainer, { left: 956, top: 600, width: 44, height: 120 })
    mockRect(mainButton, { left: 956, top: 640, width: 44, height: 40 })

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 978,
      clientY: 660,
    })
    act(() => {
      vi.advanceTimersByTime(350)
    })
    fireEvent.pointerMove(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 120,
      clientY: 520,
    })
    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 120,
      clientY: 520,
    })

    expect(getFloatingButtonConfig(store).side).toBe("left")
    expect(getFloatingButtonConfig(store).position).toBeCloseTo(0.46)
  })

  it("persists the right side and vertical position after dragging to the right half", () => {
    vi.useFakeTimers()
    setViewport(1000, 1000)
    const { store } = renderFloatingButton({ position: 0.6, side: "left" })

    const mainButton = getMainButton()
    const floatingButtonContainer = screen.getByTestId("floating-button-container")
    mockRect(floatingButtonContainer, { left: 0, top: 600, width: 44, height: 120 })
    mockRect(mainButton, { left: 0, top: 640, width: 44, height: 40 })

    fireEvent.pointerDown(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 22,
      clientY: 660,
    })
    act(() => {
      vi.advanceTimersByTime(350)
    })
    fireEvent.pointerMove(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 520,
    })
    fireEvent.pointerUp(mainButton, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 900,
      clientY: 520,
    })

    expect(getFloatingButtonConfig(store).side).toBe("right")
    expect(getFloatingButtonConfig(store).position).toBeCloseTo(0.46)
  })

  it("mirrors the controls when attached to the left edge", () => {
    renderFloatingButton({ side: "left" })

    const closeTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.floatingButtonOptions",
    })
    const lockTrigger = screen.getByRole("button", {
      name: "options.floatingButton.tooltips.lockPosition",
    })
    const mainButton = getMainButton()
    const hiddenButtons = screen
      .getAllByRole("button")
      .filter((button) => button !== closeTrigger && button !== lockTrigger)

    expect(mainButton).toHaveClass("rounded-r-full")
    expect(mainButton).toHaveClass("-translate-x-6")
    expect(closeTrigger).toHaveClass("right-0")
    expect(lockTrigger).toHaveClass("right-0")
    for (const hiddenButton of hiddenButtons) {
      expect(hiddenButton).toHaveClass("-translate-x-12")
    }

    fireEvent.mouseEnter(mainButton)

    expect(mainButton).toHaveClass("translate-x-0")
    expect(closeTrigger).toHaveClass("-right-6")
    expect(lockTrigger).toHaveClass("-right-6")
    for (const hiddenButton of hiddenButtons) {
      expect(hiddenButton).toHaveClass("translate-x-0")
    }
  })

  describe("guidance when the side panel cannot be opened or closed", () => {
    const WINDOW_ID = 456
    const originalGlobalChrome = (globalThis as { chrome?: unknown }).chrome
    const originalGlobalBrowser = (globalThis as { browser?: unknown }).browser

    afterEach(() => {
      // The test environment supplies a global `chrome.sidePanel`; a case that needs a browser
      // without one hides it, and puts it back here (the file's own stubs are left alone).
      vi.stubGlobal("chrome", originalGlobalChrome)
      vi.stubGlobal("browser", originalGlobalBrowser)
    })

    async function flush() {
      await act(async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      })
    }

    async function clickMainButton(clientX = 900) {
      const mainButton = getMainButton()
      fireEvent.pointerDown(mainButton, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX,
        clientY: 500,
      })
      vi.advanceTimersByTime(349)
      fireEvent.pointerUp(mainButton, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX,
        clientY: 500,
      })
      await flush()
      return mainButton
    }

    function toastCopy(callIndex = 0) {
      const { unmount } = render(<>{toastAddMock.mock.calls[callIndex]?.[0]?.title}</>)
      return unmount
    }

    /** The button talks to the REAL background handler, which talks to a fake `chrome.sidePanel`. */
    function connectBackground(
      browser: unknown,
      { windowId = WINDOW_ID }: { windowId?: number | null } = {},
    ) {
      const logger = {
        error: vi.fn<(...args: any[]) => any>(),
        warn: vi.fn<(...args: any[]) => any>(),
      }
      const handlers = new Map<string, (message: unknown) => Promise<unknown>>()
      const start = () =>
        setupSidePanelMessageHandler({
          extensionBrowser: browser as any,
          logger,
          registerMessageHandler: ((
            type: string,
            handler: (message: unknown) => Promise<unknown>,
          ) => {
            handlers.set(type, handler)
          }) as any,
        })
      start()
      vi.mocked(sendMessage).mockImplementation(((type: string, data: unknown) =>
        handlers.get(type)?.({
          data,
          sender: { tab: { id: 123, ...(windowId === null ? {} : { windowId }) } },
        })) as never)
      return { logger, restartWorker: start }
    }

    function connectChrome(level: SidePanelLevel, options?: { windowId?: number | null }) {
      const chrome: FakeChromeSidePanel = createFakeChromeSidePanel(level)
      const background = connectBackground({ sidePanel: chrome.api }, options)
      return {
        chrome,
        ...background,
        restartWorker: () => {
          chrome.workerDies()
          background.restartWorker()
        },
      }
    }

    describe("the answer, as the background sends it", () => {
      async function clickWith(result: unknown, side: "left" | "right" = "right") {
        vi.useFakeTimers()
        vi.mocked(sendMessage).mockResolvedValue(result as never)
        renderFloatingButton({ clickAction: "panel", side })
        return clickMainButton(side === "right" ? 900 : 20)
      }

      it.each([
        ["unsupported", "info", "sidePanel.unsupportedHint"],
        ["toggle-failed", "error", "sidePanel.failedHint"],
        ["missing-window", "error", "sidePanel.failedHint"],
      ])("a %s answer is explained next to the button (%s)", async (reason, type, copyKey) => {
        const mainButton = await clickWith({ ok: false, reason })

        expect(toastAddMock).toHaveBeenCalledTimes(1)
        expect(toastAddMock).toHaveBeenCalledWith({
          id: "side-panel-unavailable",
          positionerProps: { anchor: mainButton, side: "left", sideOffset: 8 },
          type,
          title: expect.anything(),
        })
        toastCopy()
        expect(screen.getByText(copyKey)).toBeInTheDocument()
      })

      it("the explanation sits on the inner side of a left-side button", async () => {
        const mainButton = await clickWith({ ok: false, reason: "toggle-failed" }, "left")

        expect(toastAddMock).toHaveBeenCalledWith(
          expect.objectContaining({
            positionerProps: { anchor: mainButton, side: "right", sideOffset: 8 },
          }),
        )
      })

      it.each([
        { ok: true, action: "opened" },
        { ok: true, action: "closed" },
      ])("a successful answer shows nothing (%j)", async (result) => {
        await clickWith(result)

        expect(toastAddMock).not.toHaveBeenCalled()
      })

      it("Firefox keeps its own explanation, and only that one", async () => {
        const mainButton = await clickWith({ ok: false, reason: "requires-extension-user-action" })

        expect(toastAddMock).toHaveBeenCalledTimes(1)
        expect(toastAddMock).toHaveBeenCalledWith({
          id: "firefox-sidebar-user-action",
          positionerProps: { anchor: mainButton, side: "left", sideOffset: 8 },
          type: "info",
          title: expect.anything(),
        })
      })
    })

    describe("against the real background handler and a fake chrome.sidePanel", () => {
      it("Chrome 116 to 140: the first click opens quietly, the second says the browser cannot close it", async () => {
        vi.useFakeTimers()
        const { chrome } = connectChrome("open-only")
        renderFloatingButton({ clickAction: "panel" })

        await clickMainButton()
        expect(chrome.isOpen(WINDOW_ID)).toBe(true)
        expect(toastAddMock).not.toHaveBeenCalled()

        await clickMainButton()
        // Opening and closing are exactly as before: nothing was reopened, the panel is untouched.
        expect(chrome.api.open).toHaveBeenCalledTimes(1)
        expect(chrome.isOpen(WINDOW_ID)).toBe(true)
        expect(toastAddMock).toHaveBeenCalledTimes(1)
        expect(toastAddMock.mock.calls[0]?.[0]).toMatchObject({
          id: "side-panel-unavailable",
          type: "info",
        })
        toastCopy()
        expect(screen.getByText("sidePanel.unsupportedHint")).toBeInTheDocument()
      })

      it("a browser with no side panel at all says it cannot", async () => {
        vi.useFakeTimers()
        vi.stubGlobal("chrome", {})
        vi.stubGlobal("browser", {})
        connectBackground({})
        renderFloatingButton({ clickAction: "panel" })

        await clickMainButton()

        expect(toastAddMock).toHaveBeenCalledTimes(1)
        expect(toastAddMock.mock.calls[0]?.[0]).toMatchObject({ type: "info" })
        toastCopy()
        expect(screen.getByText("sidePanel.unsupportedHint")).toBeInTheDocument()
      })

      it.each(["open-only", "events", "full"] as SidePanelLevel[])(
        "a rejected open says so, and the retry is not scolded (%s)",
        async (level) => {
          vi.useFakeTimers()
          const { chrome } = connectChrome(level)
          chrome.api.open.mockRejectedValueOnce(
            new Error("may only be called in response to a user action"),
          )
          renderFloatingButton({ clickAction: "panel" })

          await clickMainButton()
          expect(toastAddMock).toHaveBeenCalledTimes(1)
          expect(toastAddMock.mock.calls[0]?.[0]).toMatchObject({
            id: "side-panel-unavailable",
            type: "error",
          })
          toastCopy()
          expect(screen.getByText("sidePanel.failedHint")).toBeInTheDocument()

          await clickMainButton()
          expect(chrome.isOpen(WINDOW_ID)).toBe(true)
          expect(toastAddMock).toHaveBeenCalledTimes(1)
        },
      )

      it.each(["events", "full"] as SidePanelLevel[])(
        "a rejected close says so (%s)",
        async (level) => {
          vi.useFakeTimers()
          const { chrome } = connectChrome(level)
          renderFloatingButton({ clickAction: "panel" })
          await clickMainButton()
          expect(toastAddMock).not.toHaveBeenCalled()
          chrome.api.close.mockRejectedValueOnce(new Error("no such window"))

          await clickMainButton()

          expect(chrome.api.close).toHaveBeenCalledTimes(1)
          expect(toastAddMock).toHaveBeenCalledTimes(1)
          expect(toastAddMock.mock.calls[0]?.[0]).toMatchObject({ type: "error" })
          toastCopy()
          expect(screen.getByText("sidePanel.failedHint")).toBeInTheDocument()
        },
      )

      it("a click from a page with no window to act on says so", async () => {
        vi.useFakeTimers()
        const { chrome } = connectChrome("full", { windowId: null })
        renderFloatingButton({ clickAction: "panel" })

        await clickMainButton()

        expect(chrome.api.open).not.toHaveBeenCalled()
        expect(toastAddMock).toHaveBeenCalledTimes(1)
        expect(toastAddMock.mock.calls[0]?.[0]).toMatchObject({ type: "error" })
        toastCopy()
        expect(screen.getByText("sidePanel.failedHint")).toBeInTheDocument()
      })

      describe("close behaviour is unchanged, and quiet when it works", () => {
        it("Chrome 141: the button still closes the panel it opened, with no message", async () => {
          vi.useFakeTimers()
          const { chrome } = connectChrome("events")
          renderFloatingButton({ clickAction: "panel" })

          await clickMainButton()
          expect(chrome.isOpen(WINDOW_ID)).toBe(true)

          await clickMainButton()
          expect(chrome.api.close).toHaveBeenCalledTimes(1)
          expect(chrome.isOpen(WINDOW_ID)).toBe(false)

          await clickMainButton()
          expect(chrome.isOpen(WINDOW_ID)).toBe(true)
          expect(toastAddMock).not.toHaveBeenCalled()
        })

        it("Chrome 142 after a worker restart: the first click opens, the second closes, with no message", async () => {
          vi.useFakeTimers()
          const { chrome, restartWorker } = connectChrome("full")
          renderFloatingButton({ clickAction: "panel" })
          await clickMainButton()
          expect(chrome.isOpen(WINDOW_ID)).toBe(true)

          restartWorker()
          chrome.api.open.mockClear()

          await clickMainButton()
          expect(chrome.api.open).toHaveBeenCalledTimes(1)
          expect(chrome.api.close).not.toHaveBeenCalled()

          await clickMainButton()
          expect(chrome.api.close).toHaveBeenCalledTimes(1)
          expect(chrome.isOpen(WINDOW_ID)).toBe(false)
          expect(toastAddMock).not.toHaveBeenCalled()
        })

        it("Chrome 142: open, close, then open again after the viewer's own X, with no message", async () => {
          vi.useFakeTimers()
          const { chrome } = connectChrome("full")
          renderFloatingButton({ clickAction: "panel" })

          await clickMainButton()
          await clickMainButton()
          expect(chrome.isOpen(WINDOW_ID)).toBe(false)
          await clickMainButton()
          expect(chrome.isOpen(WINDOW_ID)).toBe(true)
          chrome.userClosesPanel(WINDOW_ID)
          await clickMainButton()

          expect(chrome.isOpen(WINDOW_ID)).toBe(true)
          expect(toastAddMock).not.toHaveBeenCalled()
        })
      })

      it("Firefox, asked from the page, keeps its own explanation and only that one", async () => {
        vi.useFakeTimers()
        vi.stubGlobal("chrome", {})
        const sidebarAction = {
          open: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
        }
        connectBackground({ sidebarAction })
        renderFloatingButton({ clickAction: "panel" })

        await clickMainButton()

        expect(sidebarAction.open).not.toHaveBeenCalled()
        expect(toastAddMock).toHaveBeenCalledTimes(1)
        expect(toastAddMock.mock.calls[0]?.[0]?.id).toBe("firefox-sidebar-user-action")
      })
    })
  })
})
