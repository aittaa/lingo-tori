// @vitest-environment node
//
// The helpers behind "check every category the request sends, at the dispatch": one read of the
// grant for all of them, the gate's `categories` option, and the provider fetch that puts the gate
// in front of usage metering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installApiUsageObserver } from "@/utils/api-usage-tracking"
import {
  assertDataConsentAll,
  createConsentGatedFetch,
  DataConsentRequiredError,
} from "@/utils/firefox-data-consent"
import { createProviderFetch } from "@/utils/providers/provider-fetch"
import {
  installChrome,
  installFirefox,
  KEY_ABSENT,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_ALL,
  WITH_CREDENTIALS,
  WITH_PAGE_URL,
} from "./firefox-permissions"

afterEach(() => {
  removePermissionsDouble()
})

describe("assertDataConsentAll", () => {
  it("reads the grant once for any number of categories", async () => {
    const permissions = installFirefox(WITH_ALL)

    await assertDataConsentAll(["authenticationInfo", "browsingActivity"])

    expect(permissions.getAll).toHaveBeenCalledTimes(1)
  })

  it("asks nothing for no category", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await assertDataConsentAll([])

    expect(permissions.browserCalls()).toBe(0)
  })

  it("names the first missing category, in the order given", async () => {
    installFirefox(WITH_CREDENTIALS)

    await expect(
      assertDataConsentAll(["authenticationInfo", "browsingActivity"]),
    ).rejects.toMatchObject({
      name: "DataConsentRequiredError",
      category: "browsingActivity",
      reason: "denied",
    })
    installFirefox(NOTHING_GRANTED)
    await expect(
      assertDataConsentAll(["authenticationInfo", "browsingActivity"]),
    ).rejects.toMatchObject({
      category: "authenticationInfo",
    })
  })

  it("fails closed when the browser has no built-in consent", async () => {
    installFirefox(KEY_ABSENT)

    await expect(assertDataConsentAll(["browsingActivity"])).rejects.toBeInstanceOf(
      DataConsentRequiredError,
    )
    await expect(assertDataConsentAll(["browsingActivity"])).rejects.toMatchObject({
      reason: "unsupported",
    })
  })

  it("never asks a Chrome build", async () => {
    const permissions = installChrome()

    await assertDataConsentAll(["authenticationInfo", "browsingActivity"])

    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("createConsentGatedFetch with categories", () => {
  const inner = vi.fn<typeof fetch>()
  beforeEach(() => {
    inner.mockReset()
    inner.mockImplementation(async () => new Response("ok"))
  })
  const url = "https://provider.example.test/v1/chat"

  it("refuses a request without a credential when the declared category is missing", async () => {
    installFirefox(NOTHING_GRANTED)
    const gated = createConsentGatedFetch(inner, { categories: ["browsingActivity"] })

    await expect(gated(url)).rejects.toMatchObject({ category: "browsingActivity" })

    expect(inner).not.toHaveBeenCalled()
  })

  it("lets it through when the category is granted, with one read", async () => {
    const permissions = installFirefox(WITH_PAGE_URL)
    const gated = createConsentGatedFetch(inner, { categories: ["browsingActivity"] })

    await gated(url)

    expect(inner).toHaveBeenCalledTimes(1)
    expect(permissions.getAll).toHaveBeenCalledTimes(1)
  })

  it("needs both when the request is also credentialed, and reads once", async () => {
    const permissions = installFirefox(WITH_ALL)
    const gated = createConsentGatedFetch(inner, {
      credentialed: true,
      categories: ["browsingActivity"],
    })

    await gated(url)

    expect(permissions.getAll).toHaveBeenCalledTimes(1)
    installFirefox(WITH_PAGE_URL)
    await expect(gated(url)).rejects.toMatchObject({ category: "authenticationInfo" })
  })

  it("reads the grant again for every call", async () => {
    const permissions = installFirefox(WITH_PAGE_URL)
    const gated = createConsentGatedFetch(inner, { categories: ["browsingActivity"] })

    await gated(url)
    permissions.report(NOTHING_GRANTED)

    await expect(gated(url)).rejects.toMatchObject({ category: "browsingActivity" })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it("asks nothing when it declares no category and the request has no credential", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await createConsentGatedFetch(inner)(url)

    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("createProviderFetch with categories", () => {
  const observer = vi.fn<(...args: unknown[]) => void>()
  beforeEach(() => {
    observer.mockReset()
    installApiUsageObserver(observer)
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}")),
    )
  })
  afterEach(() => {
    installApiUsageObserver(() => {})
    vi.unstubAllGlobals()
  })

  it("does not meter a request that the category check refused", async () => {
    installFirefox(NOTHING_GRANTED)
    const providerFetch = createProviderFetch({
      feature: "customAction",
      credentialed: false,
      categories: ["browsingActivity"],
    })

    await expect(providerFetch("https://provider.example.test/v1/chat")).rejects.toBeInstanceOf(
      DataConsentRequiredError,
    )

    expect(fetch).not.toHaveBeenCalled()
    expect(observer).not.toHaveBeenCalled()
  })

  it("meters an admitted request once", async () => {
    installFirefox(WITH_PAGE_URL)
    const providerFetch = createProviderFetch({
      feature: "customAction",
      credentialed: false,
      categories: ["browsingActivity"],
    })

    await providerFetch("https://provider.example.test/v1/chat")

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledTimes(1)
  })
})
