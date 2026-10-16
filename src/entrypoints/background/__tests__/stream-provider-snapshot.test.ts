// The provider a background stream runs on. A caller that holds a provider configuration (the
// selection popover, a custom action) sends it with the request, and the background must build
// the model AND the call parameters from that one configuration. A caller that sends only the
// provider's id (an older content script) keeps the id lookup.
//
// Real: the content-side stream clients, the background port dispatcher and both stream handlers,
// the payload validation, the model factory, the AI SDK and the storage helpers over the
// extension's in-memory browser storage. Doubled: the port transport and the provider's network
// edge (shared helpers).

import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  expectedFrom,
  PROVIDER_ID,
  providerRow,
  storeProvider,
  summarize,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installProviderTransport } from "@/utils/content-script/__tests__/provider-transport"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import {
  streamBackgroundStructuredObject,
  streamBackgroundText,
} from "@/utils/content-script/background-stream-client"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"

const INVALID_START = "Invalid stream start payload"
const DISABLED_MESSAGE = "Enable this provider in Settings before using it."

let bridge: ReturnType<typeof installStreamPortBridge>
let transport: ReturnType<typeof installProviderTransport>

beforeEach(() => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  transport = installProviderTransport(JSON.stringify({ result: "done" }))
})

afterEach(() => {
  bridge.dispose()
  vi.unstubAllGlobals()
})

/** What a caller builds from the row it resolved: the parameters come from that row. */
function textPayload(row: LLMProviderConfig, extra: Record<string, unknown> = {}) {
  return {
    usageFeature: "selectionTranslation" as const,
    providerKind: "local" as const,
    providerId: PROVIDER_ID,
    instructions: "Translate to Korean",
    prompt: "Hello",
    ...buildLocalGenerateTextParams(row),
    ...extra,
  }
}

function structuredPayload(row: LLMProviderConfig, extra: Record<string, unknown> = {}) {
  return {
    usageFeature: "customAction" as const,
    providerId: PROVIDER_ID,
    instructions: "Explain",
    prompt: "Hello",
    outputSchema: [{ name: "result", type: "string" as const }],
    ...buildLocalGenerateTextParams(row),
    ...extra,
  }
}

// One table for both streams: the same row, the same cases, a different handler.
const STREAMS = [
  {
    name: "text stream",
    run: (
      row: LLMProviderConfig,
      extra: Record<string, unknown> = {},
      options: { signal?: AbortSignal } = {},
    ) => streamBackgroundText(textPayload(row, extra), options),
  },
  {
    name: "structured stream",
    run: (
      row: LLMProviderConfig,
      extra: Record<string, unknown> = {},
      options: { signal?: AbortSignal } = {},
    ) => streamBackgroundStructuredObject(structuredPayload(row, extra), options),
  },
] as const

describe.each(STREAMS)("$name: the request comes from one provider configuration", ({ run }) => {
  it("builds the model and every parameter from the configuration the caller sent, not from the stored row", async () => {
    await storeProvider(providerRow("b"))

    await run(providerRow("a"), { providerConfig: providerRow("a") })

    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("takes the parameters from the configuration even when the payload's own copies disagree", async () => {
    await storeProvider(providerRow("a"))

    await run(providerRow("a"), {
      providerConfig: providerRow("a"),
      temperature: 0.77,
      providerOptions: { "openai-compatible": { user: "stale-options" } },
    })

    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("still runs when the stored row was deleted after the caller took its configuration", async () => {
    await storeProvider(null)

    await run(providerRow("a"), { providerConfig: providerRow("a") })

    expect(transport.requests).toHaveLength(1)
    expect(summarize(transport.requests[0]!)).toEqual(expectedFrom("a"))
  })

  it("keeps the id lookup for a sender that sends only the provider id (an older content script)", async () => {
    await storeProvider(providerRow("b"))

    await run(providerRow("a"))

    expect(transport.requests).toHaveLength(1)
    // The model, endpoint, credential and header come from the stored row; the parameters are the
    // sender's own, exactly as before the configuration was sent.
    expect(summarize(transport.requests[0]!)).toEqual({
      ...expectedFrom("b"),
      temperature: expectedFrom("a").temperature,
      user: expectedFrom("a").user,
    })
  })

  it("rejects an id-only request for a stored row that is disabled, before any provider call", async () => {
    await storeProvider({ ...providerRow("a"), enabled: false })

    await expect(run(providerRow("a"))).rejects.toThrow(DISABLED_MESSAGE)
    expect(transport.requests).toHaveLength(0)
  })

  it("rejects a configuration that is disabled, before any provider call", async () => {
    await storeProvider(providerRow("a"))
    const disabled = { ...providerRow("a"), enabled: false } as LLMProviderConfig

    await expect(run(disabled, { providerConfig: disabled })).rejects.toThrow(DISABLED_MESSAGE)
    expect(transport.requests).toHaveLength(0)
  })

  it("rejects a configuration whose id is not the request's provider id, before any provider call", async () => {
    await storeProvider(providerRow("a"))
    const other = { ...providerRow("a"), id: "another-provider" }

    await expect(run(providerRow("a"), { providerConfig: other })).rejects.toThrow(INVALID_START)
    expect(transport.requests).toHaveLength(0)
  })

  it("rejects a malformed configuration, before any provider call", async () => {
    await storeProvider(providerRow("a"))
    const malformed = { ...providerRow("a"), unexpected: true } as unknown as LLMProviderConfig

    await expect(run(providerRow("a"), { providerConfig: malformed })).rejects.toThrow(
      INVALID_START,
    )
    expect(transport.requests).toHaveLength(0)
  })

  it("rejects a request for a provider that does not exist and carries no configuration", async () => {
    await storeProvider(null)

    await expect(run(providerRow("a"))).rejects.toThrow(`Provider ${PROVIDER_ID} not found`)
    expect(transport.requests).toHaveLength(0)
  })
})

// Closing the popover (or restarting the run) aborts the request; that must hold on every path.
describe.each(STREAMS)("$name: aborting", ({ run }) => {
  it.each([
    ["with a configuration", { providerConfig: providerRow("a") }],
    ["by id only", {}],
  ])(
    "before the background has seen the request sends nothing to the provider (%s)",
    async (_label, extra) => {
      await storeProvider(providerRow("a"))
      bridge.hold()
      const controller = new AbortController()
      const settled = run(providerRow("a"), extra, { signal: controller.signal })
      await vi.waitFor(() => expect(bridge.pending).toBe(1))

      controller.abort()
      await expect(settled).rejects.toMatchObject({ name: "AbortError" })
      bridge.release()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(transport.requests).toHaveLength(0)
    },
  )

  it.each([
    ["with a configuration", { providerConfig: providerRow("a") }],
    ["by id only", {}],
  ])("while the provider is answering aborts the provider request (%s)", async (_label, extra) => {
    await storeProvider(providerRow("a"))
    const slow = installProviderTransport(JSON.stringify({ result: "done" }), { hold: true })
    const controller = new AbortController()
    const settled = run(providerRow("a"), extra, { signal: controller.signal })
    await vi.waitFor(() => expect(slow.requests).toHaveLength(1))

    controller.abort()

    await expect(settled).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(slow.aborted).toBe(1))
  })
})
