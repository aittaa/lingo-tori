// @vitest-environment jsdom
// A custom action runs on ONE version of its provider row. The popover computes the model's
// reasoning, provider options and temperature from the row it resolved (version A) and sends the
// request to the background. If the same row is edited while that message is on its way, the
// background must not read the row again and pair version B's model, endpoint and credential
// with version A's parameters.
//
// Real: the hook, the plan builder, the content-side stream client (`createPortStreamPromise`),
// the background port dispatcher and structured-stream handler, the model factory, the AI SDK and
// the storage helpers over the extension's in-memory browser storage. Doubled: the port transport
// (a linked pair that can hold the start message back) and the provider's network edge.

import type { LLMProviderConfig } from "@/types/config/provider"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { ANALYTICS_SURFACE } from "@/types/analytics"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  expectedFrom,
  PROVIDER_ID,
  providerRow,
  storeProvider,
  summarize,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installProviderTransport } from "@/utils/content-script/__tests__/provider-transport"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import {
  buildCustomActionExecutionPlan,
  useCustomActionExecution,
} from "../use-custom-action-execution"

function actionWithOneField() {
  const action = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)
  return {
    ...action,
    id: "synthetic-custom-action",
    outputSchema: [{ id: "f1", name: "result", type: "string" as const, description: "" }],
  }
}

interface HookProps {
  executionContext: ReturnType<typeof buildCustomActionExecutionPlan>["executionContext"]
  open: boolean
}

function propsFor(row: LLMProviderConfig, open = true): HookProps {
  const provider = resolveProviderRefForCapability("customAction", [row], PROVIDER_ID)
  if (!provider) throw new Error("The test provider must resolve")
  const plan = buildCustomActionExecutionPlan(
    { language: DEFAULT_CONFIG.language, action: actionWithOneField(), provider },
    "selected words",
    "selected words in a sentence",
    null,
  )
  return { executionContext: plan.executionContext, open }
}

function mountRun(row: LLMProviderConfig) {
  return renderHook(
    (props: HookProps) =>
      useCustomActionExecution({
        analyticsSurface: ANALYTICS_SURFACE.SELECTION_TOOLBAR,
        bodyRef: { current: null },
        popoverSessionKey: 0,
        rerunNonce: 0,
        ...props,
      }),
    { initialProps: propsFor(row) },
  )
}

let bridge: ReturnType<typeof installStreamPortBridge>
let transport: ReturnType<typeof installProviderTransport>

beforeEach(async () => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  transport = installProviderTransport(JSON.stringify({ result: "done" }))
})

afterEach(() => {
  cleanup()
  bridge.dispose()
  vi.unstubAllGlobals()
})

describe("a custom action's request is built from one version of its provider row", () => {
  it("sends the unedited row's endpoint, credential, header, model, temperature and options (unchanged behaviour)", async () => {
    await storeProvider(providerRow("a"))
    const { result } = mountRun(providerRow("a"))

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("uses only version A when the row is edited to version B while the request is still on its way", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    const { result } = mountRun(providerRow("a"))
    await waitFor(() => expect(bridge.pending).toBe(1))

    // The same row, edited in Settings: new endpoint, key, header, model, temperature and options.
    await storeProvider(providerRow("b"))
    await act(async () => {
      bridge.release()
    })
    await waitFor(() => expect(result.current.isRunning).toBe(false))

    expect(result.current.error).toBeNull()
    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("still runs on version A when the row is deleted before the background looks at it", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    const { result } = mountRun(providerRow("a"))
    await waitFor(() => expect(bridge.pending).toBe(1))

    await storeProvider(null)
    await act(async () => {
      bridge.release()
    })
    await waitFor(() => expect(result.current.isRunning).toBe(false))

    expect(result.current.error).toBeNull()
    expect(result.current.result).toEqual({ result: "done" })
    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("restarts on the new version when the popover itself sees the edit: the first request never reaches the provider", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    const { result, rerender } = mountRun(providerRow("a"))
    await waitFor(() => expect(bridge.pending).toBe(1))

    await storeProvider(providerRow("b"))
    rerender(propsFor(providerRow("b")))
    await waitFor(() => expect(bridge.pending).toBe(2))
    await act(async () => {
      bridge.release()
    })
    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("b"))
  })

  it("sends nothing to the provider when the popover is closed before the background saw the request", async () => {
    await storeProvider(providerRow("a"))
    bridge.hold()
    const { rerender } = mountRun(providerRow("a"))
    await waitFor(() => expect(bridge.pending).toBe(1))

    rerender(propsFor(providerRow("a"), false))
    await act(async () => {
      bridge.release()
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(transport.requests).toHaveLength(0)
  })
})
