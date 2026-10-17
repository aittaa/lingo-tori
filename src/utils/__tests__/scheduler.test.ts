import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWorkPacer, pauseIfBudgetSpent, yieldToMain } from "../scheduler"

// These tests drive the event loop by hand. Every backend queues its wake-up in `createEventLoop()`
// (or, for the timer fallback, on the fake clock) instead of resolving at once, so a test decides
// when a turn of the loop happens and can see what ran before it and after it. A yield that returns
// without waiting for its backend is then visible, which a backend that resolves immediately hides.
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function createEventLoop() {
  const tasks: Array<() => void> = []
  return {
    post: (task: () => void) => {
      tasks.push(task)
    },
    pending: () => tasks.length,
    /** Runs the queued tasks in order, one turn each, with the microtasks drained after every turn. */
    async runAll() {
      while (tasks.length > 0) {
        tasks.shift()!()
        await flushMicrotasks()
      }
    },
  }
}

type EventLoop = ReturnType<typeof createEventLoop>

/** A MessageChannel whose message is delivered by a turn of `loop`; every instance is recorded. */
function stubMessageChannel(loop: EventLoop) {
  const channels: Array<{ port1: { onmessage: (() => void) | null; close: () => void } }> = []
  class FakeMessageChannel {
    port1 = { onmessage: null as (() => void) | null, close: vi.fn<() => void>() }
    port2 = {
      postMessage: (_message: unknown) => {
        loop.post(() => this.port1.onmessage?.())
      },
    }

    constructor() {
      channels.push(this)
    }
  }
  vi.stubGlobal("MessageChannel", FakeMessageChannel)
  return channels
}

/**
 * Calls yieldToMain() while another task (an "input event") is already waiting in the event loop,
 * and checks what a yield is for: it does not come back before the loop has had a turn, and when
 * it does, the task that was waiting has run first.
 */
async function expectYieldToWaitForEventLoop(options: {
  queueInputEvent: (log: string[]) => void
  whileWaiting?: () => void
  turn: () => Promise<void>
  afterTurn?: () => void
}) {
  const log: string[] = []
  options.queueInputEvent(log)

  void yieldToMain().then(() => {
    log.push("resumed")
  })
  await flushMicrotasks()
  expect(log, "yieldToMain came back before the event loop had a turn").toEqual([])
  options.whileWaiting?.()

  await options.turn()
  await flushMicrotasks()
  expect(log, "the waiting task must run before yieldToMain comes back").toEqual([
    "input event",
    "resumed",
  ])
  options.afterTurn?.()
}

describe("yieldToMain", () => {
  it("prefers scheduler.yield, and waits for the promise it returns", async () => {
    const loop = createEventLoop()
    const yieldFn = vi.fn<() => Promise<void>>(() => new Promise((resolve) => loop.post(resolve)))
    const postTask =
      vi.fn<(callback: () => void, options?: { priority?: string }) => Promise<void>>()
    vi.stubGlobal("scheduler", { yield: yieldFn, postTask })
    const channels = stubMessageChannel(loop)

    await expectYieldToWaitForEventLoop({
      queueInputEvent: (log) => loop.post(() => log.push("input event")),
      whileWaiting: () => expect(yieldFn).toHaveBeenCalledTimes(1),
      turn: () => loop.runAll(),
    })

    expect(yieldFn).toHaveBeenCalledTimes(1)
    expect(postTask).not.toHaveBeenCalled()
    expect(channels).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("falls back to scheduler.postTask, and waits for the task to run", async () => {
    const loop = createEventLoop()
    const postTask = vi.fn<
      (callback: () => void, options?: { priority?: string }) => Promise<void>
    >(
      (callback) =>
        new Promise((resolve) =>
          loop.post(() => {
            callback()
            resolve()
          }),
        ),
    )
    vi.stubGlobal("scheduler", { postTask })
    const channels = stubMessageChannel(loop)

    await expectYieldToWaitForEventLoop({
      queueInputEvent: (log) => loop.post(() => log.push("input event")),
      whileWaiting: () => expect(postTask).toHaveBeenCalledTimes(1),
      turn: () => loop.runAll(),
    })

    expect(postTask).toHaveBeenCalledTimes(1)
    expect(postTask.mock.calls[0]![1]).toEqual({ priority: "user-visible" })
    expect(channels).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("falls back to MessageChannel when no scheduler exists, and waits for the message", async () => {
    const loop = createEventLoop()
    vi.stubGlobal("scheduler", undefined)
    const channels = stubMessageChannel(loop)

    await expectYieldToWaitForEventLoop({
      queueInputEvent: (log) => loop.post(() => log.push("input event")),
      whileWaiting: () => {
        expect(channels).toHaveLength(1)
        expect(channels[0]!.port1.close).not.toHaveBeenCalled()
      },
      turn: () => loop.runAll(),
      afterTurn: () => expect(channels[0]!.port1.close).toHaveBeenCalledTimes(1),
    })

    expect(channels).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("falls back to setTimeout when MessageChannel is unavailable, and waits for the timer", async () => {
    vi.stubGlobal("scheduler", undefined)
    vi.stubGlobal("MessageChannel", undefined)

    await expectYieldToWaitForEventLoop({
      queueInputEvent: (log) => {
        setTimeout(() => log.push("input event"), 0)
      },
      // The input event's timer, and the one the yield armed behind it.
      whileWaiting: () => expect(vi.getTimerCount()).toBe(2),
      turn: async () => {
        await vi.advanceTimersByTimeAsync(0)
      },
    })

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("pauseIfBudgetSpent", () => {
  const BUDGET_MS = 12

  function stubDeferredYield() {
    const loop = createEventLoop()
    const yieldFn = vi.fn<() => Promise<void>>(() => new Promise((resolve) => loop.post(resolve)))
    vi.stubGlobal("scheduler", { yield: yieldFn })
    return { loop, yieldFn }
  }

  it("does not yield while the slice budget remains", async () => {
    const { loop, yieldFn } = stubDeferredYield()
    const pacer = createWorkPacer(BUDGET_MS)
    const deadline = pacer.deadline
    vi.advanceTimersByTime(BUDGET_MS - 1) // one millisecond of the slice is left

    let returned = false
    void pauseIfBudgetSpent(pacer).then(() => {
      returned = true
    })
    await flushMicrotasks()

    expect(yieldFn).not.toHaveBeenCalled()
    expect(returned, "no yield was needed, so it must return without a turn of the loop").toBe(true)
    expect(loop.pending()).toBe(0)
    expect(pacer.deadline).toBe(deadline)
  })

  it("yields once the budget is spent, waits for the yield, then renews the deadline after it", async () => {
    const { loop, yieldFn } = stubDeferredYield()
    const pacer = createWorkPacer(BUDGET_MS)
    const spentDeadline = pacer.deadline
    vi.advanceTimersByTime(BUDGET_MS) // the deadline is reached exactly

    let returned = false
    void pauseIfBudgetSpent(pacer).then(() => {
      returned = true
    })
    await flushMicrotasks()

    expect(yieldFn).toHaveBeenCalledTimes(1)
    expect(returned, "it came back before the yield finished").toBe(false)
    expect(pacer.deadline, "the deadline was renewed before the yield finished").toBe(spentDeadline)

    // Other work runs during the yield and takes 30 ms of the clock.
    vi.advanceTimersByTime(30)
    await loop.runAll()
    await flushMicrotasks()

    expect(returned).toBe(true)
    expect(pacer.deadline).toBe(performance.now() + BUDGET_MS)
    expect(pacer.deadline).toBe(spentDeadline + 30 + BUDGET_MS)
    expect(yieldFn).toHaveBeenCalledTimes(1)
  })
})
