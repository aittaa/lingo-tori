// @vitest-environment jsdom
// A custom action turned OFF and ON again while its run is in flight. The popover
// resolves a disabled action to "no plan", so the hook sees execution key K, then
// nothing, then K again. The cancelled run used to leave K as the "last run" key
// (the rerun was skipped) and never cleared `isRunning` (the loading state and a
// partial result stuck on screen).
//
// The real hook is mounted with the real plan builder; only the background stream
// client is a double, and each stream is a deferred promise the test settles.

import type { BackgroundStructuredObjectStreamSnapshot } from "@/types/background-stream"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ANALYTICS_SURFACE } from "@/types/analytics"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { streamBackgroundStructuredObject } from "@/utils/content-script/background-stream-client"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import {
  buildCustomActionExecutionPlan,
  useCustomActionExecution,
} from "../use-custom-action-execution"

const { structuredStreamMock } = vi.hoisted(() => ({
  structuredStreamMock: vi.fn<typeof streamBackgroundStructuredObject>(),
}))
vi.mock("@/utils/content-script/background-stream-client", () => ({
  streamBackgroundStructuredObject: structuredStreamMock,
}))

type Snapshot = BackgroundStructuredObjectStreamSnapshot

interface StreamCall {
  signal: AbortSignal
  chunk: (snapshot: Snapshot) => void
  resolve: (snapshot: Snapshot) => void
  reject: (error: unknown) => void
}

const streams: StreamCall[] = []
/** The real client rejects with an AbortError once its signal fires; a test can opt out to settle late. */
let abortSettlesStream = true

function snapshot(text: string, status: "thinking" | "complete" = "complete"): Snapshot {
  return { output: { result: text }, thinking: { status, text: "" } }
}

function createProvider() {
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
  if (!provider) throw new Error("The test provider must resolve")
  return provider
}

type ActionKind = "user action" | "built-in action"

function actionFor(kind: ActionKind): SelectionToolbarCustomAction {
  const builtIn = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)
  return kind === "built-in action" ? builtIn : { ...builtIn, id: "synthetic-custom-action" }
}

interface HookProps {
  executionContext: ReturnType<typeof buildCustomActionExecutionPlan>["executionContext"]
  open: boolean
  popoverSessionKey: number
  rerunNonce: number
}

/** What the popover hands the hook: a disabled action resolves to no action, hence no plan. */
function props(
  kind: ActionKind,
  actionEnabled: boolean,
  overrides: Partial<Omit<HookProps, "executionContext">> = {},
): HookProps {
  const plan = buildCustomActionExecutionPlan(
    {
      language: DEFAULT_CONFIG.language,
      action: actionEnabled ? actionFor(kind) : null,
      provider: createProvider(),
    },
    "synthetic selection",
    "synthetic context",
    null,
  )
  return {
    executionContext: plan.executionContext,
    open: true,
    popoverSessionKey: 0,
    rerunNonce: 0,
    ...overrides,
  }
}

function mountHook(initialProps: HookProps) {
  return renderHook(
    (hookProps: HookProps) =>
      useCustomActionExecution({
        analyticsSurface: ANALYTICS_SURFACE.SELECTION_TOOLBAR,
        bodyRef: { current: null },
        ...hookProps,
      }),
    { initialProps },
  )
}

beforeEach(() => {
  streams.length = 0
  abortSettlesStream = true
  structuredStreamMock.mockReset()
  structuredStreamMock.mockImplementation((_payload, options) => {
    return new Promise<Snapshot>((resolve, reject) => {
      const signal = options?.signal ?? new AbortController().signal
      streams.push({
        signal,
        chunk: (next) => options?.onChunk?.(next),
        resolve,
        reject,
      })
      signal.addEventListener("abort", () => {
        if (abortSettlesStream) reject(new DOMException("Aborted", "AbortError"))
      })
    })
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe.each<ActionKind>(["user action", "built-in action"])(
  "a %s turned off and on again mid-run",
  (kind) => {
    it("aborts the old stream, starts a new one and keeps isRunning truthful throughout", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))
      expect(hook.result.current.isRunning).toBe(true)
      act(() => streams[0]!.chunk(snapshot("partial", "thinking")))
      expect(hook.result.current.result).toEqual({ result: "partial" })

      // The action is switched off: the plan disappears.
      hook.rerender(props(kind, false))

      expect(streams[0]!.signal.aborted).toBe(true)
      expect.soft(hook.result.current.isRunning).toBe(false)

      // …and on again: the same execution key returns.
      hook.rerender(props(kind, true))

      await waitFor(() => expect(streams).toHaveLength(2))
      expect(streams[1]!.signal.aborted).toBe(false)
      expect(hook.result.current.isRunning).toBe(true)
      // The cancelled run's partial output is gone.
      expect(hook.result.current.result).toBeNull()
      expect(hook.result.current.error).toBeNull()

      await act(async () => streams[1]!.resolve(snapshot("final")))
      expect(hook.result.current.isRunning).toBe(false)
      expect(hook.result.current.result).toEqual({ result: "final" })
      expect(structuredStreamMock).toHaveBeenCalledTimes(2)
    })

    it("clears the running state as soon as the plan disappears, and leaves it clear if it never returns", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))
      expect(hook.result.current.isRunning).toBe(true)

      hook.rerender(props(kind, false))
      await act(async () => {
        await Promise.resolve()
      })

      expect.soft(hook.result.current.isRunning).toBe(false)
      expect(structuredStreamMock).toHaveBeenCalledTimes(1)
      // The aborted stream's AbortError is not reported as a failure.
      expect(hook.result.current.error).toBeNull()
    })

    it("ignores a late result, late chunks and a late failure from the aborted stream", async () => {
      abortSettlesStream = false
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))

      hook.rerender(props(kind, false))
      hook.rerender(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(2))

      // Everything the cancelled run says from now on is stale.
      await act(async () => {
        streams[0]!.chunk(snapshot("stale partial", "thinking"))
        streams[0]!.resolve(snapshot("stale final"))
      })
      expect(hook.result.current.result).toBeNull()
      expect(hook.result.current.isRunning).toBe(true)
      await act(async () => {
        streams[0]!.reject(new Error("stale failure"))
      })
      expect(hook.result.current.error).toBeNull()
      expect(hook.result.current.isRunning).toBe(true)

      act(() => streams[1]!.chunk(snapshot("fresh partial", "thinking")))
      expect(hook.result.current.result).toEqual({ result: "fresh partial" })
      await act(async () => streams[1]!.resolve(snapshot("fresh final")))
      expect(hook.result.current.result).toEqual({ result: "fresh final" })
      expect(hook.result.current.isRunning).toBe(false)
    })

    it("does not re-run a completed run, even across an off/on that completed first", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))
      await act(async () => streams[0]!.resolve(snapshot("final")))
      expect(hook.result.current.isRunning).toBe(false)

      // Same inputs again (new objects, same key): nothing to run.
      hook.rerender(props(kind, true))
      expect(structuredStreamMock).toHaveBeenCalledTimes(1)

      // The action is switched off and on after the run finished: the result for these
      // exact inputs is still on screen, so no provider call is spent on it again.
      hook.rerender(props(kind, false))
      hook.rerender(props(kind, true))
      await act(async () => {
        await Promise.resolve()
      })
      expect(structuredStreamMock).toHaveBeenCalledTimes(1)
      expect(hook.result.current.result).toEqual({ result: "final" })
      expect(hook.result.current.isRunning).toBe(false)
    })

    it("runs again for a changed key while keeping the old stream cancelled", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))

      hook.rerender(props(kind, true, { rerunNonce: 1 }))

      await waitFor(() => expect(streams).toHaveLength(2))
      expect(streams[0]!.signal.aborted).toBe(true)
      expect(streams[1]!.signal.aborted).toBe(false)
      expect(hook.result.current.isRunning).toBe(true)
      await act(async () => streams[1]!.resolve(snapshot("final")))
      expect(hook.result.current.isRunning).toBe(false)
    })

    it("closing and reopening the popover aborts the run and starts the new session's run", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))

      hook.rerender(props(kind, true, { open: false }))
      expect(streams[0]!.signal.aborted).toBe(true)
      expect(structuredStreamMock).toHaveBeenCalledTimes(1)

      hook.rerender(props(kind, true, { open: true, popoverSessionKey: 1 }))

      await waitFor(() => expect(streams).toHaveLength(2))
      expect(hook.result.current.isRunning).toBe(true)
      await act(async () => streams[1]!.resolve(snapshot("final")))
      expect(hook.result.current.result).toEqual({ result: "final" })
    })

    it("reopening with the same key after a close runs again, as before", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))
      await act(async () => streams[0]!.resolve(snapshot("final")))

      hook.rerender(props(kind, true, { open: false }))
      hook.rerender(props(kind, true, { open: true }))

      await waitFor(() => expect(streams).toHaveLength(2))
      expect(hook.result.current.isRunning).toBe(true)
    })

    it("reports a failure and stops running", async () => {
      const hook = mountHook(props(kind, true))
      await waitFor(() => expect(streams).toHaveLength(1))

      await act(async () => streams[0]!.reject(new Error("provider failed")))

      expect(hook.result.current.isRunning).toBe(false)
      expect(hook.result.current.error).not.toBeNull()
    })
  },
)
