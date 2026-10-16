import { vi } from "vitest"

/**
 * A fake `chrome.sidePanel` that models the panel itself, for the three API levels Chrome has had:
 * `open-only` (116 to 140: `open` and nothing else), `events` (141: `close` and `onOpened`) and
 * `full` (142: `onClosed` too). It tracks which windows really have the panel open, fires the events
 * each level fires, and can play the viewer's own X and the worker dying.
 *
 * Only the browser edge is replaced; the background handler under test is the real one.
 */
export type SidePanelLevel = "open-only" | "events" | "full"

interface Listener {
  (info: { windowId?: number }): void
}

export function createFakeChromeSidePanel(level: SidePanelLevel) {
  /** What the browser really shows: the windows whose side panel is open. */
  const open = new Set<number>()
  const onOpened: Listener[] = []
  const onClosed: Listener[] = []
  const fire = (listeners: Listener[], windowId: number) => {
    for (const listener of listeners) listener({ windowId })
  }

  const api: Record<string, any> = {
    open: vi.fn<(options: { windowId: number }) => Promise<void>>(({ windowId }) => {
      const wasOpen = open.has(windowId)
      open.add(windowId)
      if (!wasOpen && level !== "open-only") fire(onOpened, windowId)
      return Promise.resolve()
    }),
  }
  if (level !== "open-only") {
    api.close = vi.fn<(options: { windowId: number }) => Promise<void>>(({ windowId }) => {
      const wasOpen = open.delete(windowId)
      if (wasOpen && level === "full") fire(onClosed, windowId)
      return Promise.resolve()
    })
    api.onOpened = {
      addListener: (listener: Listener) => {
        onOpened.push(listener)
      },
    }
  }
  if (level === "full") {
    api.onClosed = {
      addListener: (listener: Listener) => {
        onClosed.push(listener)
      },
    }
  }

  return {
    api,
    isOpen: (windowId: number) => open.has(windowId),
    /** The viewer closes the panel with its own X. */
    userClosesPanel(windowId: number) {
      const wasOpen = open.delete(windowId)
      if (wasOpen && level === "full") fire(onClosed, windowId)
    },
    /** The worker dies: the listeners it registered go with it. The panel stays as it is. */
    workerDies() {
      onOpened.length = 0
      onClosed.length = 0
    },
  }
}

export type FakeChromeSidePanel = ReturnType<typeof createFakeChromeSidePanel>
