// @vitest-environment node
//
// The background `backgroundFetch` handler fetches for content scripts and other contexts (icons
// and logo images today). It is a generic proxy, so a request handed to it can carry a credential.
// On a Firefox build such a request starts only while `authenticationInfo` is granted; a request
// without a credential (what icons and logos are) is never held back, and a Chrome build is not
// gated and does not ask the browser anything.
//
// A request can also carry the browser's own stored cookies: `credentials: "include"` asks the
// browser to attach them to a cross-origin request, and they never show in the caller's headers. That
// mode counts as a credential. `omit` (what icons and logos use, and what the proxy defaults to) and
// `same-origin` (the fetch default) do not: neither attaches cookies to a cross-origin request, and
// the proxy fetches other sites from the extension's own origin. The caller's mode is never changed.
//
// These tests do not import the consent module: on the base commit the credentialed request is sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createConsentGatedFetch } from "@/utils/firefox-data-consent"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
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
    installFirefox(NOTHING_GRANTED)

    const outcome = await backgroundFetch(data).then(
      () => "fetched" as const,
      (error: unknown) => error,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("still fetches an icon or a logo, which carries no credential, and asks nothing", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

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

const withCookies = { url: "https://provider.example.test/v1/me", credentials: "include" }

describe("Firefox, a request that asks for the browser's cookies (credentials: include)", () => {
  it("does not fetch while authenticationInfo is not granted", async () => {
    installFirefox(NOTHING_GRANTED)

    const outcome = await backgroundFetch(withCookies).then(
      () => "fetched" as const,
      (error: unknown) => error,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("fetches once it is granted, in the mode the caller asked for", async () => {
    installFirefox(WITH_CREDENTIALS)

    await expect(backgroundFetch(withCookies)).resolves.toMatchObject({ status: 200 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: "include" })
  })

  it.each([
    ["omit", { url: ICON_URL, credentials: "omit" }, "omit"],
    ["same-origin", { url: ICON_URL, credentials: "same-origin" }, "same-origin"],
    ["no mode at all (the proxy sends nothing)", { url: ICON_URL }, "omit"],
  ])("does not ask for %s, and leaves the mode as it is", async (_name, data, sent) => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await expect(backgroundFetch(data)).resolves.toMatchObject({ status: 200 })

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: sent })
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("Firefox, the mode of a Request object", () => {
  const url = "https://provider.example.test/v1/me"
  const gated = () => createConsentGatedFetch(fetchMock)

  it("counts when the Request itself says include", async () => {
    installFirefox(NOTHING_GRANTED)

    await expect(gated()(new Request(url, { credentials: "include" }))).rejects.toMatchObject({
      name: "DataConsentRequiredError",
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("lets the init override the Request, as fetch does: include in the init counts", async () => {
    installFirefox(NOTHING_GRANTED)

    await expect(
      gated()(new Request(url, { credentials: "omit" }), { credentials: "include" }),
    ).rejects.toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("lets the init override the Request: omit in the init wins over include", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await gated()(new Request(url, { credentials: "include" }), { credentials: "omit" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it("does not count a Request with the default mode, same-origin", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await gated()(new Request(url))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it("lets an include Request through once authenticationInfo is granted", async () => {
    installFirefox(WITH_CREDENTIALS)

    await gated()(new Request(url, { credentials: "include" }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("Chrome build", () => {
  it("never asks the browser about a request that asks for cookies", async () => {
    const permissions = installChrome()

    await expect(backgroundFetch(withCookies)).resolves.toMatchObject({ status: 200 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it("fetches a request that carries a credential and never asks the browser", async () => {
    const permissions = installChrome()

    await expect(backgroundFetch(withHeader)).resolves.toMatchObject({ status: 200 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})
