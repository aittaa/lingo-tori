// The Firefox built-in data consent gate, as a unit: when a credentialed transmission may start,
// how the gate learns about a grant or a revocation, how a request is recognised as carrying a
// credential, and the fetch wrapper that holds a credentialed request back.
//
// The rules (Mozilla's built-in consent, Firefox 140+):
// - A Chrome build is never gated: Chrome's policy is met by disclosure, not by this API.
// - Firefox with consent support: allowed only while `data_collection` (the list of granted
//   optional categories) holds the category. The answer is read from the browser for every new
//   request, so a revocation in about:addons stops the next request and nothing is cached.
// - Firefox without the `data_collection` key reports no consent API at all: fail closed.
// - Requests that carry no credential are never gated.
//
// The behaviour of the real call sites (SDK providers, DeepL, DeepLX, streams, BYOS, the proxy and
// the options page) is covered by the dispatch tests next to this file.

import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { defaultRequestRetryPolicy, getRequestErrorMeta } from "@/utils/request/retry-policy"
import {
  assertDataConsent,
  createConsentGatedFetch,
  DataConsentRequiredError,
  findDataConsentError,
  getDataConsentStatus,
  isDataConsentRequiredError,
  requestCarriesCredentials,
  requestDataConsent,
  watchDataConsent,
} from ".."
import {
  installChrome,
  KEY_ABSENT,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

afterEach(removePermissionsDouble)

describe("getDataConsentStatus", () => {
  it("is not applicable on a Chrome build, which never asks the browser", async () => {
    const permissions = installChrome()

    expect(await getDataConsentStatus("authenticationInfo")).toBe("not-applicable")
    expect(permissions.browserCalls()).toBe(0)
  })

  it("is granted once Firefox reports the category", async () => {
    installFirefox(WITH_CREDENTIALS)

    expect(await getDataConsentStatus("authenticationInfo")).toBe("granted")
  })

  it("is denied while nothing optional is granted, which is the state after install", async () => {
    installFirefox(NOTHING_GRANTED)

    expect(await getDataConsentStatus("authenticationInfo")).toBe("denied")
  })

  it("is unsupported when Firefox reports no data_collection key at all", async () => {
    installFirefox(KEY_ABSENT)

    expect(await getDataConsentStatus("authenticationInfo")).toBe("unsupported")
  })

  it("fails closed when the browser cannot be asked", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    permissions.getAll.mockRejectedValue(new Error("permissions API unavailable"))
    permissions.contains.mockRejectedValue(new Error("permissions API unavailable"))

    expect(await getDataConsentStatus("authenticationInfo")).not.toBe("granted")
    expect(await getDataConsentStatus("authenticationInfo")).not.toBe("not-applicable")
  })

  it("follows a revocation and a later grant, because it asks the browser every time", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    expect(await getDataConsentStatus("authenticationInfo")).toBe("granted")

    permissions.report(NOTHING_GRANTED)
    expect(await getDataConsentStatus("authenticationInfo")).toBe("denied")

    permissions.report(WITH_CREDENTIALS)
    expect(await getDataConsentStatus("authenticationInfo")).toBe("granted")
  })
})

describe("assertDataConsent", () => {
  it("lets a Chrome build and a granted Firefox through", async () => {
    installChrome()
    await expect(assertDataConsent("authenticationInfo")).resolves.toBeUndefined()
    removePermissionsDouble()

    installFirefox(WITH_CREDENTIALS)
    await expect(assertDataConsent("authenticationInfo")).resolves.toBeUndefined()
  })

  it("refuses a denied Firefox with a typed error that names the category and the reason", async () => {
    installFirefox(NOTHING_GRANTED)

    const error = await assertDataConsent("authenticationInfo").catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DataConsentRequiredError)
    expect(error).toMatchObject({ category: "authenticationInfo", reason: "denied" })
    expect((error as Error).message).not.toBe("")
  })

  it("refuses a Firefox without consent support with its own reason", async () => {
    installFirefox(KEY_ABSENT)

    await expect(assertDataConsent("authenticationInfo")).rejects.toMatchObject({
      name: "DataConsentRequiredError",
      reason: "unsupported",
    })
  })
})

describe("isDataConsentRequiredError", () => {
  it("recognises the error by name, which is all that survives extension messaging", () => {
    expect(
      isDataConsentRequiredError(new DataConsentRequiredError("authenticationInfo", "denied")),
    ).toBe(true)
    const clone = { name: "DataConsentRequiredError", message: "Data consent is required" }
    expect(isDataConsentRequiredError(clone)).toBe(true)
  })

  it("does not mistake other errors for it", () => {
    expect(isDataConsentRequiredError(new Error("Data consent is required"))).toBe(false)
    expect(isDataConsentRequiredError(new TypeError("fetch failed"))).toBe(false)
    expect(isDataConsentRequiredError(undefined)).toBe(false)
    expect(isDataConsentRequiredError("DataConsentRequiredError")).toBe(false)
  })
})

describe("requestDataConsent (called from a user gesture)", () => {
  it("asks Firefox for exactly the category and returns the user's answer", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    permissions.answerPrompts(true)

    await expect(requestDataConsent("authenticationInfo")).resolves.toBe(true)

    expect(permissions.request).toHaveBeenCalledTimes(1)
    expect(permissions.request).toHaveBeenCalledWith({ data_collection: ["authenticationInfo"] })
    expect(await getDataConsentStatus("authenticationInfo")).toBe("granted")
  })

  it("returns false when the user declines, and the state stays denied", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    permissions.answerPrompts(false)

    await expect(requestDataConsent("authenticationInfo")).resolves.toBe(false)

    expect(await getDataConsentStatus("authenticationInfo")).toBe("denied")
  })

  it("starts the prompt in the same turn, before any await, so the gesture is still live", () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    void requestDataConsent("authenticationInfo")

    expect(permissions.request).toHaveBeenCalledTimes(1)
  })

  it("does not prompt a Chrome build, where there is nothing to grant", async () => {
    const permissions = installChrome()

    await expect(requestDataConsent("authenticationInfo")).resolves.toBe(true)

    expect(permissions.request).not.toHaveBeenCalled()
  })

  it("reports no grant, and does not throw, on a Firefox that has no consent support", async () => {
    const permissions = installFirefox(KEY_ABSENT)
    // Such a browser rejects a data_collection request as an unknown permission.
    permissions.request.mockRejectedValue(new Error("Invalid permission data_collection"))

    await expect(requestDataConsent("authenticationInfo")).resolves.toBe(false)
  })
})

describe("requestCarriesCredentials", () => {
  const url = "https://provider.example.test/v1/chat/completions"

  it.each([
    ["Authorization", { Authorization: "Bearer sk-test" }],
    ["lower-case authorization", { authorization: "Bearer sk-test" }],
    ["X-Api-Key", { "X-Api-Key": "sk-test" }],
    ["api-key (Azure)", { "api-key": "sk-test" }],
    ["x-goog-api-key (Google)", { "x-goog-api-key": "sk-test" }],
    ["a subscription key header", { "Ocp-Apim-Subscription-Key": "sk-test" }],
    ["Proxy-Authorization", { "Proxy-Authorization": "Basic dGVzdA==" }],
    ["Cookie", { Cookie: "session=abc" }],
  ])("recognises %s", (_name, headers) => {
    expect(requestCarriesCredentials(url, { headers })).toBe(true)
  })

  it("reads the headers whatever form they come in", () => {
    const secret = ["Authorization", "Bearer sk-test"] as [string, string]
    expect(requestCarriesCredentials(url, { headers: new Headers([secret]) })).toBe(true)
    expect(requestCarriesCredentials(url, { headers: [secret] })).toBe(true)
    expect(requestCarriesCredentials(new Request(url, { headers: [secret] }))).toBe(true)
  })

  it.each([
    ["userinfo", "https://user:pass@provider.example.test/v1/chat"],
    ["a key query parameter", "https://provider.example.test/v1/chat?key=sk-test"],
    ["an api_key query parameter", "https://provider.example.test/v1/chat?api_key=sk-test"],
    ["an access_token query parameter", "https://provider.example.test/v1/chat?access_token=abc"],
  ])("recognises %s in the URL", (_name, withCredential) => {
    expect(requestCarriesCredentials(withCredential)).toBe(true)
    expect(requestCarriesCredentials(new URL(withCredential))).toBe(true)
  })

  it("does not take ordinary headers and URLs for credentials", () => {
    expect(
      requestCarriesCredentials(url, {
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "X-Title": "LingoTori",
          "HTTP-Referer": "https://example.test",
        },
      }),
    ).toBe(false)
    expect(requestCarriesCredentials(url)).toBe(false)
    expect(
      requestCarriesCredentials("https://provider.example.test/v1/chat?model=gpt&stream=1"),
    ).toBe(false)
  })
})

describe("createConsentGatedFetch", () => {
  const url = "https://provider.example.test/v1/chat/completions"
  const withKey = { headers: { Authorization: "Bearer sk-test" } }
  const keyless = { headers: { "Content-Type": "application/json" } }

  function inner() {
    return vi.fn<typeof fetch>(async () => new Response("ok"))
  }

  it("sends nothing for a credentialed request while the category is denied", async () => {
    installFirefox(NOTHING_GRANTED)
    const send = inner()

    await expect(createConsentGatedFetch(send)(url, withKey)).rejects.toMatchObject({
      name: "DataConsentRequiredError",
    })

    expect(send).not.toHaveBeenCalled()
  })

  it("sends a credentialed request once granted, with the arguments untouched", async () => {
    installFirefox(WITH_CREDENTIALS)
    const send = inner()

    const response = await createConsentGatedFetch(send)(url, withKey)

    expect(await response.text()).toBe("ok")
    expect(send).toHaveBeenCalledWith(url, withKey)
  })

  it("never holds back a request that carries no credential, and never asks the browser", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    const send = inner()

    await createConsentGatedFetch(send)(url, keyless)

    expect(send).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it("gates a keyless-looking request when the caller knows it is credentialed", async () => {
    installFirefox(NOTHING_GRANTED)
    const send = inner()

    // DeepLX can carry the key inside the URL path, which no header or query check can see.
    await expect(
      createConsentGatedFetch(send, { credentialed: true })(url, keyless),
    ).rejects.toMatchObject({ name: "DataConsentRequiredError" })

    expect(send).not.toHaveBeenCalled()
  })

  it("checks every request, so a revocation stops the next one but not the one that started", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    const send = inner()
    const gated = createConsentGatedFetch(send)

    await gated(url, withKey)
    permissions.report(NOTHING_GRANTED)
    await expect(gated(url, withKey)).rejects.toMatchObject({ name: "DataConsentRequiredError" })

    expect(send).toHaveBeenCalledTimes(1)
  })

  it("is transparent on a Chrome build and never asks the browser", async () => {
    const permissions = installChrome()
    const send = inner()

    await createConsentGatedFetch(send)(url, withKey)

    expect(send).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it("fails closed on a Firefox that reports no consent support", async () => {
    installFirefox(KEY_ABSENT)
    const send = inner()

    await expect(createConsentGatedFetch(send)(url, withKey)).rejects.toMatchObject({
      reason: "unsupported",
    })

    expect(send).not.toHaveBeenCalled()
  })
})

describe("DataConsentRequiredError and the request queue", () => {
  const context = {
    retryCount: 0,
    maxRetries: 3,
    baseRetryDelayMs: 1000,
    now: Date.now(),
    rateLimitRetryCount: 0,
    consecutiveRateLimits: 0,
  }
  const refusal = () => new DataConsentRequiredError("authenticationInfo", "denied")

  it("is not retried: a refusal is not a transient failure, and each retry would only ask again", () => {
    expect(defaultRequestRetryPolicy.decide(refusal(), context).action).toBe("fail")
  })

  it("is not taken for a network failure, a timeout or a rate limit by its message", () => {
    expect(["network", "timeout", "rate-limit"]).not.toContain(getRequestErrorMeta(refusal()).kind)
  })
})

describe("findDataConsentError", () => {
  const refusal = () => new DataConsentRequiredError("browsingActivity", "denied")

  it("finds the refusal itself, and in the wrappers that carry it", () => {
    const direct = refusal()
    expect(findDataConsentError(direct)).toBe(direct)
    // An SDK retry error holds the error of the later attempt; a re-thrown stream error holds its
    // original as the cause.
    expect(findDataConsentError({ name: "AI_RetryError", lastError: direct })).toBe(direct)
    expect(
      findDataConsentError({ name: "AI_RetryError", errors: [new Error("503"), direct] }),
    ).toBe(direct)
    expect(findDataConsentError(new Error("wrapped", { cause: direct }))).toBe(direct)
  })

  it("returns nothing for other errors, and does not loop on a cycle", () => {
    expect(findDataConsentError(new Error("503"))).toBeUndefined()
    expect(findDataConsentError(undefined)).toBeUndefined()
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(findDataConsentError(cyclic)).toBeUndefined()
  })
})

describe("an answer that arrives after a revocation", () => {
  it("is the answer that counts: nothing remembered from the earlier grant is used", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // The browser answers when it gets to the call, which is after the user revoked.
    permissions.getAll.mockImplementationOnce(async () => {
      await held
      return { permissions: [], origins: [], data_collection: [] }
    })
    const send = vi.fn<typeof fetch>(async () => new Response("ok"))

    const outcome = createConsentGatedFetch(send)("https://provider.example.test/v1", {
      headers: { Authorization: "Bearer sk-test" },
    }).then(
      () => "sent" as const,
      (error: unknown) => error,
    )
    release()

    expect(await outcome).toMatchObject({ name: "DataConsentRequiredError" })
    expect(send).not.toHaveBeenCalled()
  })
})

describe("watchDataConsent", () => {
  it("listens for added and removed permissions on Firefox, and stops when told to", () => {
    installFirefox(NOTHING_GRANTED)
    const added = vi
      .spyOn(fakeBrowser.permissions.onAdded, "addListener")
      .mockImplementation(() => {})
    const removed = vi
      .spyOn(fakeBrowser.permissions.onRemoved, "addListener")
      .mockImplementation(() => {})
    const removeAdded = vi
      .spyOn(fakeBrowser.permissions.onAdded, "removeListener")
      .mockImplementation(() => {})
    const onChange = vi.fn<() => void>()

    const stop = watchDataConsent(onChange)
    expect(added).toHaveBeenCalledWith(onChange)
    expect(removed).toHaveBeenCalledWith(onChange)

    stop()
    expect(removeAdded).toHaveBeenCalledWith(onChange)
  })

  it("listens for nothing on a Chrome build", () => {
    installChrome()
    const added = vi
      .spyOn(fakeBrowser.permissions.onAdded, "addListener")
      .mockImplementation(() => {})

    watchDataConsent(() => {})()

    expect(added).not.toHaveBeenCalled()
  })
})
