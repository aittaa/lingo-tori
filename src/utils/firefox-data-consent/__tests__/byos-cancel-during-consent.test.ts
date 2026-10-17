// Starting the ChatGPT sign-in reads Firefox's consent just before the authorization page is opened
// in the sign-in tab. That read is asynchronous, and the sign-in can be cancelled, replaced or can
// expire while it is pending. The navigation must belong to the attempt that is still current when
// the read answers: a cancelled attempt never navigates, even while its cleanup is still running
// and the tab has not been removed yet.
//
// These tests drive the real service with a doubled vault, tab transport and `fetch`, hold the
// second consent read (the one right before navigation), and change the attempt while it is held.
//
// These tests do not import the consent module: on the base commit the stale navigation happens.

import type { Mock } from "vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  credentials,
  fetchUrl,
  memoryVault,
  mockTransport,
} from "@/utils/byos/__tests__/auth-fixtures"
import { RESOURCE } from "@/utils/byos/oidc"
import { createByosService } from "@/utils/byos/service"
import { installFirefox, removePermissionsDouble, WITH_CREDENTIALS } from "./firefox-permissions"

const target = {
  extensionId: "lingotori@aittaa",
  callbackUrl: "moz-extension://a702f145-d458-4acf-9101-6549d0c2babc/byos-callback.html",
}
const ATTEMPT = "7d8f3c52-4f1e-4b1f-9a52-0c3f6d1e2a10"

afterEach(() => {
  vi.useRealTimers()
  removePermissionsDouble()
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A sign-in about to navigate: the second consent read is held until `releaseConsent()`. */
async function holdingBeforeNavigation(now: () => number = Date.now) {
  const permissions = installFirefox(WITH_CREDENTIALS)
  const consent = deferred()
  let reads = 0
  permissions.getAll.mockImplementation(async () => {
    reads++
    if (reads === 2) await consent.promise
    return { permissions: [], origins: [], data_collection: [...WITH_CREDENTIALS] }
  })
  const vault = memoryVault()
  const transport = mockTransport()
  const fetcher = vi.fn<typeof fetch>()
  const service = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    fetcher,
    now,
  )
  const started = service.authStart(ATTEMPT).then(
    () => "navigated" as const,
    (error: unknown) => error,
  )
  await vi.waitFor(() => expect(reads).toBe(2))
  return { vault, transport, service, started, releaseConsent: consent.resolve }
}

const afterTurns = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("a sign-in cancelled while the navigation consent read is pending", () => {
  it("does not navigate, even while the cancelled attempt's cleanup is still running", async () => {
    const { transport, service, started, releaseConsent } = await holdingBeforeNavigation()
    const cleanup = deferred()
    ;(transport.cleanup as Mock).mockImplementation(() => cleanup.promise)

    const cancelled = service.cancelAuth(ATTEMPT)
    await vi.waitFor(() => expect(transport.cleanup).toHaveBeenCalled())
    releaseConsent()
    await afterTurns()

    // The tab is still there and the cleanup has not finished: nothing may open the page now.
    expect(transport.navigate).not.toHaveBeenCalled()

    cleanup.resolve()
    await cancelled
    expect(await started).toMatchObject({ code: "session_changed" })
    expect(transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate when the attempt was cancelled and nothing else happened", async () => {
    const { transport, service, started, releaseConsent } = await holdingBeforeNavigation()

    await service.cancelAuth(ATTEMPT)
    releaseConsent()

    expect(await started).toMatchObject({ code: "session_changed" })
    expect(transport.navigate).not.toHaveBeenCalled()
  })
})

describe("a sign-in whose pending record changes while the navigation consent read is pending", () => {
  it("does not navigate for an attempt that expired meanwhile", async () => {
    let clock = 1_000_000
    const { transport, started, releaseConsent } = await holdingBeforeNavigation(() => clock)

    clock += 301_000
    releaseConsent()

    expect(await started).toBeDefined()
    expect(transport.navigate).not.toHaveBeenCalled()
  })

  it("cannot be replaced by a second sign-in: that one is refused, and this one still navigates", async () => {
    // Every change of the attempt that the service makes moves the in-memory intent, and a second
    // sign-in is refused while one is starting, so a replacement through the service is not
    // possible in this window. A record rewritten from outside the service during the final
    // consent read is out of the model; it is covered while the vault is read, before that read
    // (see byos-navigation-window.test.ts).
    const { transport, service, started, releaseConsent } = await holdingBeforeNavigation()

    await expect(service.authStart("0b9f2d1c-3a44-4f6e-9a55-2f1c8e7d6b10")).rejects.toMatchObject({
      code: "auth_in_progress",
    })
    releaseConsent()

    expect(await started).toBe("navigated")
    expect(transport.navigate).toHaveBeenCalledTimes(1)
  })
})

describe("a sign-in nobody touches while the navigation consent read is pending", () => {
  it("navigates once, to the authorization page of its own attempt", async () => {
    const { vault, transport, started, releaseConsent } = await holdingBeforeNavigation()
    const pending = (await vault.read()).pending

    releaseConsent()

    expect(await started).toBe("navigated")
    expect(transport.navigate).toHaveBeenCalledTimes(1)
    expect(transport.navigate).toHaveBeenCalledWith(
      pending!.tabId,
      expect.stringContaining(`state=${pending!.state}`),
    )
  })
})

describe("a ChatGPT request whose consent read is pending when the session ends", () => {
  /** A connected account; the first consent read is held, the later ones answer at once. */
  async function connectedHoldingFirstRead() {
    const permissions = installFirefox(WITH_CREDENTIALS)
    const consent = deferred()
    let reads = 0
    permissions.getAll.mockImplementation(async () => {
      reads++
      if (reads === 1) await consent.promise
      return { permissions: [], origins: [], data_collection: [...WITH_CREDENTIALS] }
    })
    const vault = memoryVault()
    await vault.update((record) => {
      record.credentials = credentials()
      record.registration = {
        clientId: "synthetic-client",
        subject: "synthetic-subject",
        email: "person@example.test",
      }
    })
    // Answers every call, and ignores the abort signal like a double does.
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ models: [] }))
    const service = createByosService(
      vault,
      mockTransport(),
      target.extensionId,
      target.callbackUrl,
      fetcher,
    )
    const models = service.models().then(
      () => "listed" as const,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(reads).toBe(1))
    return { service, fetcher, models, releaseConsent: consent.resolve }
  }

  const modelListCalls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
    fetcher.mock.calls.filter(([input]) => fetchUrl(input) === `${RESOURCE}/models`)

  it("is not sent when the user signed out meanwhile", async () => {
    const { service, fetcher, models, releaseConsent } = await connectedHoldingFirstRead()

    const signedOut = service.signout()
    releaseConsent()
    await signedOut

    expect(await models).toMatchObject({ code: "session_changed" })
    expect(modelListCalls(fetcher)).toHaveLength(0)
  })

  it("is sent when nothing happened", async () => {
    const { fetcher, models, releaseConsent } = await connectedHoldingFirstRead()

    releaseConsent()

    expect(await models).toBe("listed")
    expect(modelListCalls(fetcher)).toHaveLength(1)
  })
})
