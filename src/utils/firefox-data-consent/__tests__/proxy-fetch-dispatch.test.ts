// @vitest-environment node
//
// The background `backgroundFetch` handler fetches for content scripts and other contexts (icons
// and logo images today). It is a generic proxy, so a request handed to it can carry a credential.
// On a Firefox build such a request starts only while `authenticationInfo` is granted; a request
// without a credential (what icons and logos are) is never held back, and a Chrome build is not
// gated and does not ask the browser anything.
//
// These tests do not import the consent module: on the base commit the credentialed request is sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  REQUIRED_ONLY,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

type Handler = (message: { data: unknown }) => Promise<unknown>

const registered = vi.hoisted(() => new Map<string, unknown>())

vi.mock("@/utils/message", () => ({
  onMessage: (name: string, handler: unknown) => {
    registered.set(name, handler)
  },
}))

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

beforeEach(async () => {
  registered.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response("ok"))
  vi.stubGlobal("fetch", fetchMock)
  const { proxyFetch } = await import("@/entrypoints/background/proxy-fetch")
  proxyFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  removePermissionsDouble()
})

function backgroundFetch(data: Record<string, unknown>) {
  const handler = registered.get("backgroundFetch") as Handler
  return handler({ data })
}

const ICON_URL = "https://icons.example.test/tabler.json?icons=copy"
const withHeader = {
  url: "https://provider.example.test/v1/models",
  headers: [["Authorization", "Bearer sk-test-123"]],
}
const withQueryKey = { url: "https://provider.example.test/v1/models?api_key=sk-test-123" }

describe("Firefox, authenticationInfo not granted", () => {
  it.each([
    ["an Authorization header", withHeader],
    ["a credential-named query parameter", withQueryKey],
  ])("does not fetch for %s", async (_name, data) => {
    installFirefox(REQUIRED_ONLY)

    const outcome = await backgroundFetch(data).then(
      () => "fetched" as const,
      (error: unknown) => error,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("still fetches an icon or a logo, which carries no credential, and asks nothing", async () => {
    const permissions = installFirefox(REQUIRED_ONLY)

    await expect(backgroundFetch({ url: ICON_URL, credentials: "omit" })).resolves.toMatchObject({
      status: 200,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("Firefox, authenticationInfo granted", () => {
  it("fetches a request that carries a credential", async () => {
    installFirefox(WITH_CREDENTIALS)

    await expect(backgroundFetch(withHeader)).resolves.toMatchObject({ status: 200 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("Chrome build", () => {
  it("fetches a request that carries a credential and never asks the browser", async () => {
    const permissions = installChrome()

    await expect(backgroundFetch(withHeader)).resolves.toMatchObject({ status: 200 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})
