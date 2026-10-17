// What crosses the provider's network edge, through the whole stream path: the content-side stream
// client, the port transport, the background dispatcher and text stream handler, the model factory
// and the real AI SDK, down to the doubled `fetch` (shared helpers).
//
// Two things the other stream tests cannot show: the provider's bytes arrive as the UTF-8 they
// were sent as (the doubled network edge encodes them with the `TextEncoder` that
// `vitest.setup.ts` installs), and a request aborted while its response body is still being read
// stops there. The existing abort tests cover an abort before the background has seen the request
// and an abort while the provider's `fetch` is still pending; here `fetch` has already returned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  PROVIDER_ID,
  providerRow,
  storeProvider,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installProviderTransport } from "@/utils/content-script/__tests__/provider-transport"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import { streamBackgroundText } from "@/utils/content-script/background-stream-client"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"

let bridge: ReturnType<typeof installStreamPortBridge>

beforeEach(() => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
})

afterEach(() => {
  bridge.dispose()
  vi.unstubAllGlobals()
})

/** The request a caller that holds the provider's configuration sends. */
function textPayload() {
  const row = providerRow("a")
  return {
    usageFeature: "selectionTranslation" as const,
    providerKind: "local" as const,
    providerId: PROVIDER_ID,
    providerConfig: row,
    instructions: "Translate to Korean",
    prompt: "Hello",
    ...buildLocalGenerateTextParams(row),
  }
}

/** Let anything still on its way through the stream path arrive. */
const settleTransport = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("a text stream over the provider's network edge", () => {
  it("returns Korean and emoji text exactly as the provider sent it", async () => {
    await storeProvider(providerRow("a"))
    const transport = installProviderTransport("안녕하세요 😀 한글")
    const chunks: string[] = []

    const result = await streamBackgroundText(textPayload(), {
      onChunk: (snapshot) => chunks.push(snapshot.output),
    })

    // Written as code points, separately from the text the provider sends above:
    // 안녕하세요, a space, 😀, a space, 한글.
    const expected = "안녕하세요 \u{1F600} 한글"
    expect(transport.requests).toHaveLength(1)
    expect(result.output).toBe(expected)
    expect(chunks.at(-1)).toBe(expected)
  })
})

describe("a text stream aborted while its response body is being read", () => {
  // The provider has answered (its `fetch` returned) and sent the first chunk of the text; the rest
  // of the body is held until the test releases it.
  const FIRST = "Hello"
  const FULL = "Hello, late tail"

  it("stops at the first chunk: the request is aborted and the late tail never arrives", async () => {
    await storeProvider(providerRow("a"))
    const transport = installProviderTransport(FULL, { holdBody: FIRST })
    const controller = new AbortController()
    const chunks: string[] = []
    const settled = streamBackgroundText(textPayload(), {
      signal: controller.signal,
      onChunk: (snapshot) => chunks.push(snapshot.output),
    })
    await vi.waitFor(() => expect(chunks).toEqual([FIRST]))
    expect(transport.bodyAborted).toBe(0)

    controller.abort()

    // The caller is cancelled, and the cancellation reached the provider request whose body is open.
    await expect(settled).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(transport.bodyAborted).toBe(1))

    // The provider sends the rest of its answer after the abort: nothing reads it, and the caller
    // still holds only the chunk it had.
    transport.releaseBody()
    await settleTransport()
    expect(transport.tailDelivered).toBe(false)
    expect(chunks).toEqual([FIRST])
    expect(transport.requests).toHaveLength(1)
  })

  it("control: the same body, not aborted, delivers the tail and completes", async () => {
    await storeProvider(providerRow("a"))
    const transport = installProviderTransport(FULL, { holdBody: FIRST })
    const chunks: string[] = []
    const settled = streamBackgroundText(textPayload(), {
      onChunk: (snapshot) => chunks.push(snapshot.output),
    })
    await vi.waitFor(() => expect(chunks).toEqual([FIRST]))

    transport.releaseBody()

    await expect(settled).resolves.toMatchObject({ output: FULL })
    expect(chunks.at(-1)).toBe(FULL)
    expect(transport.tailDelivered).toBe(true)
    expect(transport.bodyAborted).toBe(0)
  })
})
