// The streaming path (selection translation, custom actions, summaries) on a Firefox build:
// content-side stream client -> port -> background dispatcher -> real model factory and AI SDK ->
// the provider's network edge, which is doubled.
//
// A stream whose provider request carries a credential starts only while `authenticationInfo` is
// granted. The refusal reaches the caller as the stream's error, with a message that says consent
// is what is missing, and nothing leaves the extension. Keyless providers and Chrome builds are
// not gated.
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
import { streamBackgroundText } from "@/utils/content-script/background-stream-client"
import { StreamPortError } from "@/utils/content-script/port-streaming"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"
import {
  installChrome,
  KEY_ABSENT,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_CREDENTIALS,
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

/** What a caller that holds the provider's configuration sends. */
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

const credentialedRow = providerRow("a")
// The same provider with no key, and an ordinary header: nothing in the request is a credential.
const keylessRow = { ...providerRow("a"), apiKey: undefined } as LLMProviderConfig

const stream = (row: LLMProviderConfig, extra: Record<string, unknown> = {}) =>
  streamBackgroundText(textPayload(row, { providerConfig: row, ...extra }))

describe("Firefox, authenticationInfo not granted", () => {
  it("does not start a credentialed stream, and tells the caller that consent is missing", async () => {
    installFirefox(NOTHING_GRANTED)

    const error = await stream(credentialedRow).catch((caught: unknown) => caught)

    expect(transport.requests).toHaveLength(0)
    expect(error).toBeInstanceOf(StreamPortError)
    expect((error as Error).message).toMatch(/consent/i)
  })

  it("does not start it either when the provider is looked up by id (an older content script)", async () => {
    installFirefox(NOTHING_GRANTED)
    await storeProvider(credentialedRow)

    await expect(streamBackgroundText(textPayload(credentialedRow))).rejects.toBeInstanceOf(
      StreamPortError,
    )

    expect(transport.requests).toHaveLength(0)
  })

  it("does not start it on a Firefox without built-in consent support", async () => {
    installFirefox(KEY_ABSENT)

    await expect(stream(credentialedRow)).rejects.toBeInstanceOf(StreamPortError)

    expect(transport.requests).toHaveLength(0)
  })

  it("still streams a keyless provider", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await expect(stream(keylessRow)).resolves.toMatchObject({ output: "done" })

    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]!.headers.authorization).toBeUndefined()
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("Firefox, authenticationInfo granted", () => {
  it("streams a credentialed provider, with its key", async () => {
    installFirefox(WITH_CREDENTIALS)

    await expect(stream(credentialedRow)).resolves.toMatchObject({ output: "done" })

    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]!.headers.authorization).toBe("Bearer key-a")
  })

  it("stops the next stream after a revocation, and honours a later grant", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    await stream(credentialedRow)
    expect(transport.requests).toHaveLength(1)

    permissions.report(NOTHING_GRANTED)
    await expect(stream(credentialedRow)).rejects.toBeInstanceOf(StreamPortError)
    expect(transport.requests).toHaveLength(1)

    permissions.report(WITH_CREDENTIALS)
    await expect(stream(credentialedRow)).resolves.toMatchObject({ output: "done" })
    expect(transport.requests).toHaveLength(2)
  })
})

describe("a provider that declares its endpoint holds a secret", () => {
  // A key typed into the URL path cannot be told from a path segment: the user says so, and the
  // declaration travels in the provider snapshot the stream request is built from.
  const declaredRow = {
    ...providerRow("a"),
    apiKey: undefined,
    baseURL: "https://provider.example.test/v1/KEY-IN-PATH-123",
    endpointNeedsConsent: true,
  } as unknown as LLMProviderConfig

  it("is refused while nothing is granted, with the message about consent", async () => {
    installFirefox(NOTHING_GRANTED)

    const error = await stream(declaredRow).catch((caught: unknown) => caught)

    expect(transport.requests).toHaveLength(0)
    expect(error).toBeInstanceOf(StreamPortError)
    expect((error as Error).message).toMatch(/consent/i)
  })

  it("streams once authenticationInfo is granted", async () => {
    installFirefox(WITH_CREDENTIALS)

    await expect(stream(declaredRow)).resolves.toMatchObject({ output: "done" })

    expect(transport.requests).toHaveLength(1)
  })

  it("is not rescued by a declaration of false when the provider also has a key", async () => {
    installFirefox(NOTHING_GRANTED)
    const keyed = {
      ...credentialedRow,
      endpointNeedsConsent: false,
    } as unknown as LLMProviderConfig

    await expect(stream(keyed)).rejects.toBeInstanceOf(StreamPortError)

    expect(transport.requests).toHaveLength(0)
  })
})

describe("a revocation that lands before the request is dispatched", () => {
  it("stops a stream whose start message is still on its way to the background", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    bridge.hold()
    const outcome = stream(credentialedRow).then(
      () => "streamed" as const,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(bridge.pending).toBe(1))

    // Admitted when the user pressed the button; revoked before the background dispatches.
    permissions.report(NOTHING_GRANTED)
    bridge.release()

    expect(await outcome).toBeInstanceOf(StreamPortError)
    expect(transport.requests).toHaveLength(0)
  })
})

describe("Chrome build", () => {
  it("streams a credentialed provider and never asks the browser for consent", async () => {
    const permissions = installChrome()

    await expect(stream(credentialedRow)).resolves.toMatchObject({ output: "done" })

    expect(transport.requests).toHaveLength(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})
