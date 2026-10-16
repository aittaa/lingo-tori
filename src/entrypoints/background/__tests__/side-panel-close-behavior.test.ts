import type { FakeChromeSidePanel, SidePanelLevel } from "./fake-side-panel"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setupSidePanelMessageHandler } from "../side-panel"
import { createFakeChromeSidePanel } from "./fake-side-panel"

/**
 * What the floating button's side-panel toggle does today, on each Chrome capability level and across
 * a service worker restart. These tests pin the OPEN and CLOSE behaviour so that adding guidance for
 * a failed or unsupported call cannot change when the panel opens or closes.
 *
 * In particular they would fail if anyone made the button open-only where the worker's own record
 * says "open": on Chrome 141 the button must keep closing the panel, and on Chrome 142 after a
 * restart it must keep behaving as it does now (the first click opens, which changes nothing on a
 * panel that is already open, and the second click closes).
 *
 * Real: `setupSidePanelMessageHandler` and the toggle handler it registers, with the event wiring it
 * does. Replaced: the browser's `sidePanel` API, by a fake that models the panel (see
 * `fake-side-panel.ts`). Unit evidence: no browser.
 */

const WINDOW_ID = 456
const message = { sender: { tab: { id: 123, windowId: WINDOW_ID } } }

type Toggle = (m: unknown) => Promise<{ ok: boolean; action?: string; reason?: string }>

function createLogger() {
  return { error: vi.fn<(...args: any[]) => any>(), warn: vi.fn<(...args: any[]) => any>() }
}

function startWorker(chrome: FakeChromeSidePanel) {
  chrome.workerDies()
  const logger = createLogger()
  const handlers = new Map<string, Toggle>()
  setupSidePanelMessageHandler({
    extensionBrowser: { sidePanel: chrome.api } as any,
    logger,
    registerMessageHandler: ((type: string, handler: Toggle) => {
      handlers.set(type, handler)
    }) as any,
  })
  const toggle = handlers.get("toggleSidePanel")
  if (!toggle) throw new Error("toggleSidePanel handler was not registered")
  return { toggle: () => toggle(message), logger }
}

describe("side panel open and close behaviour (unchanged)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("Chrome 142 and later: open, close, and onOpened / onClosed", () => {
    it("toggles open, closed, open", async () => {
      const chrome = createFakeChromeSidePanel("full")
      const { toggle } = startWorker(chrome)

      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)
      await expect(toggle()).resolves.toEqual({ ok: true, action: "closed" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(false)
      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)
    })

    it("a viewer who closes the panel with its X gets it back on the next click", async () => {
      const chrome = createFakeChromeSidePanel("full")
      const { toggle } = startWorker(chrome)
      await toggle()

      chrome.userClosesPanel(WINDOW_ID)

      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)
    })

    it("after a worker restart with the panel open, the first click opens and the second CLOSES (as before)", async () => {
      const chrome = createFakeChromeSidePanel("full")
      await startWorker(chrome).toggle()
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)

      // The worker idles out; the next click wakes a fresh one that has seen no event.
      const { toggle } = startWorker(chrome)
      chrome.api.open.mockClear()

      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.api.open).toHaveBeenCalledTimes(1)
      expect(chrome.api.close).not.toHaveBeenCalled()

      // Not open-only: the button still closes a panel it has just recorded as open.
      await expect(toggle()).resolves.toEqual({ ok: true, action: "closed" })
      expect(chrome.api.close).toHaveBeenCalledTimes(1)
      expect(chrome.api.close).toHaveBeenCalledWith({ windowId: WINDOW_ID })
      expect(chrome.isOpen(WINDOW_ID)).toBe(false)
    })
  })

  describe("Chrome 141: close and onOpened, no onClosed", () => {
    it("the button closes the panel it opened", async () => {
      const chrome = createFakeChromeSidePanel("events")
      const { toggle } = startWorker(chrome)

      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)

      // The second click must close: this is the behaviour an open-only rule would remove.
      await expect(toggle()).resolves.toEqual({ ok: true, action: "closed" })
      expect(chrome.api.close).toHaveBeenCalledTimes(1)
      expect(chrome.api.close).toHaveBeenCalledWith({ windowId: WINDOW_ID })
      expect(chrome.isOpen(WINDOW_ID)).toBe(false)

      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)
    })

    it("known stale record, left as it is on purpose: after the viewer's own X, the next click still calls close()", async () => {
      // No onClosed on this level, so the worker is never told. Deliberately NOT changed by the
      // guidance work (the reconciliation design is on hold); pinned so a change here is a decision.
      const chrome = createFakeChromeSidePanel("events")
      const { toggle } = startWorker(chrome)
      await toggle()

      chrome.userClosesPanel(WINDOW_ID)

      await expect(toggle()).resolves.toEqual({ ok: true, action: "closed" })
      expect(chrome.api.close).toHaveBeenCalledTimes(1)
    })
  })

  describe("Chrome 116 to 140: open only", () => {
    it("the first click opens", async () => {
      const chrome = createFakeChromeSidePanel("open-only")
      const { toggle } = startWorker(chrome)

      await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)
    })

    it("the second click is answered unsupported (close does not exist), and opens nothing again", async () => {
      const chrome = createFakeChromeSidePanel("open-only")
      const { toggle, logger } = startWorker(chrome)
      await toggle()
      chrome.api.open.mockClear()

      await expect(toggle()).resolves.toEqual({ ok: false, reason: "unsupported" })

      expect(chrome.api.open).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        "Side panel close API is unavailable in this browser",
      )
      expect(chrome.isOpen(WINDOW_ID)).toBe(true)
    })
  })

  describe("every level", () => {
    it.each(["open-only", "events", "full"] as SidePanelLevel[])(
      "opens in the same task as the click, before anything is awaited (%s)",
      (level) => {
        const chrome = createFakeChromeSidePanel(level)
        const { toggle } = startWorker(chrome)

        void toggle()

        expect(chrome.api.open).toHaveBeenCalledTimes(1)
        expect(chrome.api.open).toHaveBeenCalledWith({ windowId: WINDOW_ID })
      },
    )

    it.each(["events", "full"] as SidePanelLevel[])(
      "a rejected open is a toggle-failed answer and the next click tries again (%s)",
      async (level) => {
        const chrome = createFakeChromeSidePanel(level)
        chrome.api.open.mockRejectedValueOnce(
          new Error("may only be called in response to a user action"),
        )
        const { toggle, logger } = startWorker(chrome)

        await expect(toggle()).resolves.toEqual({ ok: false, reason: "toggle-failed" })
        expect(logger.error).toHaveBeenCalledWith("Failed to open side panel", expect.any(Error))

        await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
        expect(chrome.isOpen(WINDOW_ID)).toBe(true)
      },
    )

    it.each(["events", "full"] as SidePanelLevel[])(
      "a rejected close is a toggle-failed answer, the record is cleared, and the next click opens (%s)",
      async (level) => {
        const chrome = createFakeChromeSidePanel(level)
        const { toggle, logger } = startWorker(chrome)
        await toggle()
        chrome.api.close.mockRejectedValueOnce(new Error("no such window"))

        await expect(toggle()).resolves.toEqual({ ok: false, reason: "toggle-failed" })
        expect(logger.error).toHaveBeenCalledWith("Failed to close side panel", expect.any(Error))

        chrome.api.open.mockClear()
        await expect(toggle()).resolves.toEqual({ ok: true, action: "opened" })
        expect(chrome.api.open).toHaveBeenCalledTimes(1)
      },
    )

    it("an open that throws before returning a promise is a toggle-failed answer", async () => {
      const chrome = createFakeChromeSidePanel("full")
      chrome.api.open.mockImplementationOnce(() => {
        throw new Error("not available")
      })
      const { toggle } = startWorker(chrome)

      await expect(toggle()).resolves.toEqual({ ok: false, reason: "toggle-failed" })
    })

    it("a sender without a window is reported, not guessed at, and nothing is opened", async () => {
      const chrome = createFakeChromeSidePanel("full")
      const handlers = new Map<string, Toggle>()
      setupSidePanelMessageHandler({
        extensionBrowser: { sidePanel: chrome.api } as any,
        logger: createLogger(),
        registerMessageHandler: ((type: string, handler: Toggle) => {
          handlers.set(type, handler)
        }) as any,
      })

      await expect(
        handlers.get("toggleSidePanel")!({ sender: { tab: { id: 1 } } }),
      ).resolves.toEqual({ ok: false, reason: "missing-window" })
      expect(chrome.api.open).not.toHaveBeenCalled()
    })

    it("a browser with no side panel API at all is answered unsupported", async () => {
      vi.stubGlobal("chrome", {})
      vi.stubGlobal("browser", {})
      const handlers = new Map<string, Toggle>()
      setupSidePanelMessageHandler({
        extensionBrowser: {} as any,
        logger: createLogger(),
        registerMessageHandler: ((type: string, handler: Toggle) => {
          handlers.set(type, handler)
        }) as any,
      })

      await expect(handlers.get("toggleSidePanel")!(message)).resolves.toEqual({
        ok: false,
        reason: "unsupported",
      })
    })

    it("Firefox, which has a sidebar instead, still opens only from an extension user action", async () => {
      vi.stubGlobal("chrome", {})
      const sidebarAction = { open: vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined) }
      const handlers = new Map<string, Toggle>()
      setupSidePanelMessageHandler({
        extensionBrowser: { sidebarAction } as any,
        logger: createLogger(),
        registerMessageHandler: ((type: string, handler: Toggle) => {
          handlers.set(type, handler)
        }) as any,
      })
      const toggle = handlers.get("toggleSidePanel")!

      await expect(toggle({ data: { source: "content-script" } })).resolves.toEqual({
        ok: false,
        reason: "requires-extension-user-action",
      })
      expect(sidebarAction.open).not.toHaveBeenCalled()

      await expect(toggle({ data: { source: "extension-user-action" } })).resolves.toEqual({
        ok: true,
        action: "opened",
      })
      expect(sidebarAction.open).toHaveBeenCalledTimes(1)
    })
  })
})
