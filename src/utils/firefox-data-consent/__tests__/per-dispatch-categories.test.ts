// A request that sends the page URL (browsingActivity) is checked at the moment each provider
// request is dispatched, not only when the stream starts.
//
// The stream handler reads the grant when the port message arrives. Between that read and the
// network call the request still awaits things (the stored provider settings, a queue, the AI SDK's
// own retry with backoff), and the user can switch the permission off in about:addons during any of
// them. A check made only at the start would then send the address after it was withdrawn, and an
// SDK retry would send it again. These tests withdraw the grant at exactly those points, through
// the real stream client, dispatcher, model factory and AI SDK, and count what reaches the
// provider's network edge (doubled).
//
// The declared categories are internal: they must never appear in the provider's request body.
//
// These tests do not import the consent module: on the base commit the request is sent.

import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  PROVIDER_ID,
  providerRow,
  storeProvider,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installProviderTransport } from "@/utils/content-script/__tests__/provider-transport"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import {
  streamBackgroundNoteSuggestion,
  streamBackgroundText,
} from "@/utils/content-script/background-stream-client"
import { StreamPortError } from "@/utils/content-script/port-streaming"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_ALL,
  WITH_CREDENTIALS,
  WITH_PAGE_URL,
} from "./firefox-permissions"

let bridge: ReturnType<typeof installStreamPortBridge>
let transport: ReturnType<typeof installProviderTransport>

beforeEach(() => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  transport = installProviderTransport("done")
})

afterEach(() => {
  bridge.dispose()
  vi.unstubAllGlobals()
  removePermissionsDouble()
})

const keylessRow = { ...providerRow("a"), apiKey: undefined } as LLMProviderConfig
const keyedRow = providerRow("a")

/** A stream that declares it sends the page URL, as a custom action with {{webUrl}} does. */
function urlStream(row: LLMProviderConfig, extra: Record<string, unknown> = {}) {
  return streamBackgroundText({
    usageFeature: "customAction",
    providerKind: "local",
    providerId: PROVIDER_ID,
    providerConfig: row,
    instructions: "Explain",
    prompt: "Explain this page: https://page.example.test/",
    dataCategories: ["browsingActivity"],
    ...buildLocalGenerateTextParams(row),
    ...extra,
  })
}

/** The first read of the grant (the stream's admission) sees `first`; every later read, the state. */
function admitOnceWith(
  permissions: ReturnType<typeof installFirefox>,
  first: readonly string[],
  later: readonly string[],
) {
  permissions.getAll.mockImplementationOnce(async () => ({
    permissions: [],
    origins: [],
    data_collection: [...first],
  }))
  permissions.report(later)
}

describe("browsingActivity withdrawn after the stream was admitted", () => {
  it("stops a keyless provider's request before it is sent", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    admitOnceWith(permissions, ["browsingActivity"], NOTHING_GRANTED)

    const error = await urlStream(keylessRow).catch((caught: unknown) => caught)

    expect(transport.requests).toHaveLength(0)
    expect(error).toBeInstanceOf(StreamPortError)
    expect((error as Error).message).toMatch(/consent/i)
  })

  it("stops a credentialed provider's request even while authenticationInfo is still granted", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    admitOnceWith(permissions, ["authenticationInfo", "browsingActivity"], WITH_CREDENTIALS)

    await expect(urlStream(keyedRow)).rejects.toBeInstanceOf(StreamPortError)

    expect(transport.requests).toHaveLength(0)
  })

  it("stops a stream that looks its provider up by id, while the settings are still being read", async () => {
    const permissions = installFirefox(WITH_PAGE_URL)
    await storeProvider(keylessRow)
    // Hold every read of the stored settings until the grant has been withdrawn.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: unknown[]
    ) => Promise<unknown>
    const get = vi
      .spyOn(fakeBrowser.storage.local, "get")
      .mockImplementation((...args: unknown[]) => held.then(() => realGet(...args)))

    const pending = streamBackgroundNoteSuggestion({
      providerId: PROVIDER_ID,
      instructions: "Suggest notes",
      prompt: "Page: https://page.example.test/",
      dataCategories: ["browsingActivity"],
    } as never).catch((caught: unknown) => caught)
    await vi.waitFor(() => expect(get).toHaveBeenCalled())
    permissions.report(NOTHING_GRANTED)
    release()
    const error = await pending

    expect(transport.requests).toHaveLength(0)
    expect(error).toBeInstanceOf(StreamPortError)
    expect((error as Error).message).toMatch(/consent/i)
  })
})

describe("browsingActivity withdrawn while the AI SDK is retrying", () => {
  /** The provider answers 503 once, and the user withdraws browsingActivity during that answer. */
  function overloadedOnce(onFirst: () => void) {
    const inner = globalThis.fetch
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        calls++
        if (calls === 1) {
          onFirst()
          return new Response("overloaded", {
            status: 503,
            headers: { "retry-after-ms": "5" },
          })
        }
        return inner(input, init)
      }),
    )
    return { calls: () => calls }
  }

  it("does not send the retry", async () => {
    const permissions = installFirefox(WITH_ALL)
    const provider = overloadedOnce(() => permissions.report(WITH_CREDENTIALS))

    const error = await urlStream(keyedRow).catch((caught: unknown) => caught)

    expect(provider.calls()).toBe(1)
    expect(error).toBeInstanceOf(StreamPortError)
    expect((error as Error).message).toMatch(/consent/i)
  })

  it("still retries when the grant is in place, so the retry check is not a refusal in disguise", async () => {
    installFirefox(WITH_ALL)
    const provider = overloadedOnce(() => {})

    await expect(urlStream(keyedRow)).resolves.toMatchObject({ output: "done" })

    expect(provider.calls()).toBe(2)
  })
})

describe("browsingActivity still granted at the dispatch", () => {
  it("sends the request, and keeps the declared categories out of the provider's body", async () => {
    installFirefox(WITH_PAGE_URL)

    await expect(urlStream(keylessRow)).resolves.toMatchObject({ output: "done" })

    expect(transport.requests).toHaveLength(1)
    const body = JSON.stringify(transport.requests[0]!.body)
    expect(body).not.toContain("dataCategories")
    expect(body).not.toContain("browsingActivity")
  })

  it("keeps them out of the body on the by-id path too", async () => {
    installFirefox(WITH_PAGE_URL)
    await storeProvider(keylessRow)

    await streamBackgroundNoteSuggestion({
      providerId: PROVIDER_ID,
      instructions: "Suggest notes",
      prompt: "Page: https://page.example.test/",
      dataCategories: ["browsingActivity"],
    } as never).catch(() => {})

    expect(transport.requests).toHaveLength(1)
    expect(JSON.stringify(transport.requests[0]!.body)).not.toContain("dataCategories")
  })

  it("asks nothing for a stream that declares no category", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await expect(urlStream(keylessRow, { dataCategories: undefined })).resolves.toMatchObject({
      output: "done",
    })

    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("Chrome build", () => {
  it("never asks the browser, whatever the stream declares", async () => {
    const permissions = installChrome()

    await expect(urlStream(keylessRow)).resolves.toMatchObject({ output: "done" })

    expect(transport.requests).toHaveLength(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})
