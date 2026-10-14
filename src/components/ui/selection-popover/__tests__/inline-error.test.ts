import type { StreamPortResponse } from "@/types/background-stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { createPortStreamPromise } from "@/utils/content-script/port-streaming"
import {
  createSelectionToolbarPrecheckError,
  createSelectionToolbarProviderRequiredError,
  createSelectionToolbarRuntimeError,
} from "../inline-error"

const UPGRADE = { label: "Upgrade", url: "https://www.readfrog.app/pricing" }

/** A port whose background answers the start message with `error`. */
function connectPortFailingWith(error: Extract<StreamPortResponse, { type: "error" }>["error"]) {
  let onMessage: ((event: StreamPortResponse) => void) | undefined
  vi.spyOn(browser.runtime, "connect").mockReturnValue({
    onMessage: {
      addListener: (listener: typeof onMessage) => {
        onMessage = listener
      },
      removeListener: vi.fn<(...args: any[]) => any>(),
    },
    onDisconnect: {
      addListener: vi.fn<(...args: any[]) => any>(),
      removeListener: vi.fn<(...args: any[]) => any>(),
    },
    postMessage: (message: { type: string; streamRequestId: string }) => {
      if (message.type === "start") {
        onMessage?.({ type: "error", streamRequestId: message.streamRequestId, error })
      }
    },
    disconnect: vi.fn<(...args: any[]) => any>(),
  } as never)
}

async function catchRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the stream to reject")
}

describe("createSelectionToolbarRuntimeError", () => {
  it("keeps selected-text translation failures available after removing the Hub locale keys", () => {
    expect(
      createSelectionToolbarRuntimeError("translate", new Error("Unexpected error occurred")),
    ).toEqual({
      title: "translation.failed",
      description: "translation.failedFallback",
      action: undefined,
    })
  })

  it("keeps the call to action the background attached to a stream failure", async () => {
    connectPortFailingWith({ message: "Quota used up", action: UPGRADE })

    const error = await catchRejection(createPortStreamPromise("stream-structured-object", {}))

    expect(createSelectionToolbarRuntimeError("customAction", error)).toEqual({
      title: "options.selectionToolbar.errors.customActionFailed",
      description: "Quota used up",
      action: UPGRADE,
    })
  })

  it("shows a stream failure without an action as a plain message", async () => {
    connectPortFailingWith({ message: "Incorrect API key provided" })

    const error = await catchRejection(createPortStreamPromise("stream-structured-object", {}))

    expect(createSelectionToolbarRuntimeError("customAction", error)).toEqual({
      title: "options.selectionToolbar.errors.customActionFailed",
      description: "Incorrect API key provided",
      action: undefined,
    })
  })

  it("never turns an `action` found on a foreign error into a button", () => {
    const providerError = Object.assign(new Error("Rate limited"), { action: UPGRADE })

    expect(createSelectionToolbarRuntimeError("customAction", providerError).action).toBeUndefined()
  })
})

describe("createSelectionToolbarProviderRequiredError", () => {
  // Stands in for the extension origin the options page lives on.
  const runtime = browser.runtime as unknown as { getURL: (path: string) => string }
  const realGetURL = runtime.getURL

  beforeEach(() => {
    runtime.getURL = (path) => `chrome-extension://test${path}`
  })

  afterEach(() => {
    runtime.getURL = realGetURL
  })

  it.each([
    ["translate", "translation.failed"],
    ["customAction", "options.selectionToolbar.errors.customActionFailed"],
  ] as const)("titles a %s failure and points its button at the given row", (kind, title) => {
    expect(
      createSelectionToolbarProviderRequiredError(kind, "feature-provider-selectionTranslation"),
    ).toEqual({
      title,
      description: "providerRequired.message",
      action: {
        label: "providerRequired.openSettings",
        url: "chrome-extension://test/options.html#/api-providers?section=feature-provider-selectionTranslation",
      },
    })
  })

  it("links a custom action to that action's own row", () => {
    expect(
      createSelectionToolbarProviderRequiredError(
        "customAction",
        "feature-provider-action-synthetic-action",
      ).action?.url,
    ).toBe(
      "chrome-extension://test/options.html#/api-providers?section=feature-provider-action-synthetic-action",
    )
  })

  it("leaves the other precheck errors without a button", () => {
    expect(createSelectionToolbarPrecheckError("translate", "providerDisabled")).toEqual({
      title: "translation.failed",
      description: "options.selectionToolbar.errors.providerDisabled",
    })
    expect(createSelectionToolbarPrecheckError("customAction", "providerUnavailable")).toEqual({
      title: "options.selectionToolbar.errors.customActionFailed",
      description: "options.selectionToolbar.errors.providerUnavailable",
    })
  })
})
