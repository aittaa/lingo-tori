// Test double for the extension's port transport, shared by the tests that drive a content-side
// caller, the real `createPortStreamPromise` client and the real background dispatcher together.
//
// `browser.runtime.connect({ name })` returns the content end of a linked pair; the other end goes
// to `dispatchBackgroundStreamPort`, the same function the background's `onConnect` listener calls.
// Nothing in between is replaced: the payload the caller builds is exactly what the background
// handler parses.
//
// A start message can be held back: the content side has posted it, the background has not seen
// it yet (a service worker that is still waking up, or a port message in flight). The test uses
// that window to change the stored configuration, then releases the message.

import type { Browser } from "#imports"
import { vi } from "vitest"
import { browser } from "#imports"
import { dispatchBackgroundStreamPort } from "@/entrypoints/background/background-stream"

type Listener<T> = (arg: T) => void

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>()
  addListener = (listener: Listener<T>) => {
    this.listeners.add(listener)
  }
  removeListener = (listener: Listener<T>) => {
    this.listeners.delete(listener)
  }
  emit(arg: T) {
    for (const listener of [...this.listeners]) listener(arg)
  }
}

function createEnd(name: string) {
  const onMessage = new Emitter<unknown>()
  const onDisconnect = new Emitter<void>()
  return { name, onMessage, onDisconnect }
}

export interface StreamPortBridge {
  /** The start payloads the content side posted, in order. */
  readonly startPayloads: unknown[]
  /** Hold every message from the content side until `release()`. */
  hold(): void
  /** Deliver everything held, in order, and stop holding. */
  release(): void
  /** Number of messages waiting for `release()`. */
  readonly pending: number
  dispose(): void
}

export function installStreamPortBridge(): StreamPortBridge {
  let holding = false
  const held: Array<() => void> = []
  const startPayloads: unknown[] = []

  const connect = vi
    .spyOn(browser.runtime, "connect")
    .mockImplementation((info?: string | { name?: string }) => {
      const name = typeof info === "string" ? info : (info?.name ?? "")
      const content = createEnd(name)
      const background = createEnd(name)
      let closed = false
      const close = (from: "content" | "background") => {
        if (closed) return
        closed = true
        ;(from === "content" ? background : content).onDisconnect.emit()
      }

      const contentPort = {
        name,
        onMessage: content.onMessage,
        onDisconnect: content.onDisconnect,
        postMessage: (message: unknown) => {
          if (closed) throw new Error("Attempting to use a disconnected port object")
          if ((message as { type?: string } | undefined)?.type === "start") {
            startPayloads.push((message as { payload: unknown }).payload)
          }
          const deliver = () => {
            if (!closed) background.onMessage.emit(structuredClone(message))
          }
          if (holding) held.push(deliver)
          else deliver()
        },
        disconnect: () => close("content"),
      }
      const backgroundPort = {
        name,
        onMessage: background.onMessage,
        onDisconnect: background.onDisconnect,
        postMessage: (message: unknown) => {
          if (closed) throw new Error("Attempting to use a disconnected port object")
          content.onMessage.emit(structuredClone(message))
        },
        disconnect: () => close("background"),
      }

      dispatchBackgroundStreamPort(backgroundPort as unknown as Browser.runtime.Port)
      return contentPort as unknown as Browser.runtime.Port
    })

  return {
    startPayloads,
    hold: () => {
      holding = true
    },
    release: () => {
      holding = false
      for (const deliver of held.splice(0)) deliver()
    },
    get pending() {
      return held.length
    },
    dispose: () => {
      connect.mockRestore()
      held.length = 0
    },
  }
}
