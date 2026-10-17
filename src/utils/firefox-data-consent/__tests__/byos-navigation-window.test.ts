// The sign-in tab is navigated to the authorization page only on a permission read that is still
// true when the navigation is called: after the final consent read, nothing slow (a vault or storage
// read) may sit between that answer and the call, because the user can switch the permission off in
// about:addons during any such wait. What the attempt owned (its intent, its pending record, its
// expiry) is checked before the final read, and the checks that can still change during it are made
// on in-memory state, in the same turn as the call. A change of the stored session that another
// operation of the same service makes during that read (a token refresh the server refuses for good)
// is one of them.
//
// These tests drive the real service with a doubled vault, tab transport and `fetch`. They record
// the order of vault reads, consent reads and the navigation, hold the last vault read or the final
// consent read, and change the permission or the attempt while it is held. The hold for "the last
// vault read" is found by counting the reads of an untouched run, so the tests do not depend on how
// many reads the service makes before it.
//
// These tests do not import the consent module: on the base commit the vault is read after the
// final consent read.

import type { Mock } from "vitest"
import type { AuthVault, VaultRecord } from "@/utils/byos/vault"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  credentials,
  fetchUrl,
  memoryVault,
  mockTransport,
} from "@/utils/byos/__tests__/auth-fixtures"
import { TOKEN_URL } from "@/utils/byos/oidc"
import { createByosService } from "@/utils/byos/service"
import { newVaultRecord } from "@/utils/byos/vault"
import { installFirefox, removePermissionsDouble, WITH_CREDENTIALS } from "./firefox-permissions"

const target = {
  extensionId: "lingotori@aittaa",
  callbackUrl: "moz-extension://a702f145-d458-4acf-9101-6549d0c2babc/byos-callback.html",
}
const ATTEMPT = "7d8f3c52-4f1e-4b1f-9a52-0c3f6d1e2a10"

afterEach(() => {
  removePermissionsDouble()
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface Options {
  /** Hold the Nth vault read (counted from the start of the sign-in) until `releaseVault()`. */
  holdVaultRead?: number
  /** The held vault read answers with the record it had when it began, not the one at release. */
  snapshotBeforeHold?: boolean
  /** Hold the Nth consent read until `releaseConsent()`. */
  holdConsentRead?: number
  /** The stored session the service starts with. */
  stored?: VaultRecord
  /** What the service's `fetch` answers; it is never called when the sign-in is untouched. */
  fetcher?: typeof fetch
}

/** A sign-in with every read and the navigation logged in `events`. */
function signIn(options: Options = {}) {
  const permissions = installFirefox(WITH_CREDENTIALS)
  const events: string[] = []
  let granted: string[] = [...WITH_CREDENTIALS]
  let consentReads = 0
  const consent = deferred()
  permissions.getAll.mockImplementation(async () => {
    consentReads++
    events.push("consent:start")
    const snapshot = [...granted]
    if (consentReads === options.holdConsentRead) {
      events.push("consent:held")
      await consent.promise
    }
    events.push("consent:end")
    return { permissions: [], origins: [], data_collection: snapshot }
  })

  const inner = memoryVault(options.stored)
  let vaultReads = 0
  let failNextWrite = false
  let failGenerationWrite = false
  const vaultGate = deferred()
  const vault: AuthVault = {
    read: async () => {
      vaultReads++
      events.push("vault:read")
      if (vaultReads === options.holdVaultRead) {
        events.push("vault:held")
        if (options.snapshotBeforeHold) {
          const snapshot = await inner.read()
          await vaultGate.promise
          return snapshot
        }
        await vaultGate.promise
      }
      return inner.read()
    },
    update: async (change) => {
      if (failGenerationWrite) {
        // The write that ends the session fails after its callback ran: the vault rolls back and the
        // stored record is left as it was.
        return inner.update((record) => {
          const generation = record.generation
          const result = change(record)
          if (record.generation === generation) return result
          failGenerationWrite = false
          throw new Error("The write failed")
        })
      }
      if (!failNextWrite) return inner.update(change)
      // The callback runs (the cancellation moves the in-memory intent there) and then the write
      // fails, so the stored record is left exactly as it was.
      failNextWrite = false
      change(structuredClone(await inner.read()))
      throw new Error("The write failed")
    },
  }
  const transport = mockTransport()
  let readsAtNavigation = -1
  ;(transport.navigate as Mock).mockImplementation(async () => {
    readsAtNavigation = vaultReads
    events.push("navigate")
  })
  const service = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    options.fetcher ?? vi.fn<typeof fetch>(),
  )
  const started = service.authStart(ATTEMPT).then(
    () => "navigated" as const,
    (error: unknown) => error,
  )
  return {
    events,
    inner,
    transport,
    service,
    started,
    revoke: () => {
      granted = []
    },
    failNextWrite: () => {
      failNextWrite = true
    },
    failGenerationWrite: () => {
      failGenerationWrite = true
    },
    releaseConsent: consent.resolve,
    releaseVault: vaultGate.resolve,
    readsAtNavigation: () => readsAtNavigation,
  }
}

const waitFor = (events: string[], event: string) =>
  vi.waitFor(() => expect(events).toContain(event))

/** How many vault reads an untouched sign-in makes before it navigates. */
async function vaultReadsBeforeNavigation(options: Options = {}) {
  const run = signIn(options)
  expect(await run.started).toBe("navigated")
  return run.readsAtNavigation()
}

describe("an untouched sign-in", () => {
  it("navigates once", async () => {
    const run = signIn()

    expect(await run.started).toBe("navigated")
    expect(run.transport.navigate).toHaveBeenCalledTimes(1)
  })

  it("reads the vault and reads the consent last, then navigates in the same turn", async () => {
    const run = signIn()
    await run.started

    const lastConsentEnd = run.events.lastIndexOf("consent:end")
    const navigation = run.events.indexOf("navigate")

    expect(lastConsentEnd).toBeGreaterThan(-1)
    expect(navigation).toBeGreaterThan(lastConsentEnd)
    // Nothing is read from the vault between the answer that admits the navigation and the call.
    expect(run.events.slice(lastConsentEnd, navigation)).not.toContain("vault:read")
  })
})

describe("the permission switched off while the last vault read is pending", () => {
  it("does not navigate", async () => {
    const lastRead = await vaultReadsBeforeNavigation()
    const run = signIn({ holdVaultRead: lastRead })
    await waitFor(run.events, "vault:held")

    run.revoke()
    run.releaseVault()
    const outcome = await run.started

    expect(run.transport.navigate).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("does not navigate for an attempt that another record replaced meanwhile", async () => {
    const lastRead = await vaultReadsBeforeNavigation()
    const run = signIn({ holdVaultRead: lastRead })
    await waitFor(run.events, "vault:held")

    await run.inner.update((record) => {
      if (record.pending) record.pending = { ...record.pending, state: "another-attempt-state" }
    })
    run.releaseVault()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })

  it("navigates when nothing changed, which is the control for the two above", async () => {
    const lastRead = await vaultReadsBeforeNavigation()
    const run = signIn({ holdVaultRead: lastRead })
    await waitFor(run.events, "vault:held")

    run.releaseVault()

    expect(await run.started).toBe("navigated")
    expect(run.transport.navigate).toHaveBeenCalledTimes(1)
  })
})

describe("the sign-in cancelled while the final consent read is pending", () => {
  it("does not navigate", async () => {
    const run = signIn({ holdConsentRead: 2 })
    await waitFor(run.events, "consent:held")

    await run.service.cancelAuth(ATTEMPT)
    run.releaseConsent()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate when the user signed out meanwhile", async () => {
    const run = signIn({ holdConsentRead: 2 })
    await waitFor(run.events, "consent:held")

    await run.service.signout()
    run.releaseConsent()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate even when the cancellation could not be saved", async () => {
    // The cancellation moves the in-memory intent first and then writes the record. A write that
    // fails leaves the stored attempt exactly as it was, and only the intent says it was cancelled.
    const run = signIn({ holdConsentRead: 2 })
    await waitFor(run.events, "consent:held")
    const stored = await run.inner.read()
    run.failNextWrite()

    await expect(run.service.cancelAuth(ATTEMPT)).rejects.toThrow("The write failed")
    expect(await run.inner.read()).toEqual(stored)
    run.releaseConsent()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })
})

describe("the stored session changed by another operation while the final consent read is pending", () => {
  /** A connected account whose access token has expired, so the next request refreshes it. */
  const expiredSession = (): VaultRecord => ({
    ...newVaultRecord(),
    credentials: { ...credentials(), expires: Date.now() - 1000 },
  })

  /** A token endpoint that answers with `response` and refuses every other address. */
  const tokenEndpoint = (response: () => Response) =>
    vi.fn<typeof fetch>(async (input) => {
      if (fetchUrl(input) !== TOKEN_URL) throw new Error("Unexpected synthetic upstream address")
      return response()
    })
  const refusedForGood = () => Response.json({ error: "invalid_grant" }, { status: 400 })
  const unavailable = () => Response.json({ error: "server_error" }, { status: 503 })

  it("does not navigate when a refresh the server refuses for good ended the session", async () => {
    const fetcher = tokenEndpoint(refusedForGood)
    const run = signIn({ holdConsentRead: 2, stored: expiredSession(), fetcher })
    await waitFor(run.events, "consent:held")
    const before = await run.inner.read()

    await expect(run.service.models()).rejects.toMatchObject({ code: "invalid_grant" })
    const after = await run.inner.read()

    // The session moved on while the sign-in waited, and the record the sign-in wrote is still there.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(after.generation).toBe(before.generation + 1)
    expect(after.pending?.state).toBe(before.pending?.state)
    expect(after.pending?.generation).not.toBe(after.generation)
    run.releaseConsent()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate even when the write that ended the session could not be saved", async () => {
    // The refresh moves the in-memory ownership first and then writes the record. A write that
    // fails leaves the stored session as it was, and only the ownership says it was ended: the
    // sign-in fails closed and the user can try again.
    const fetcher = tokenEndpoint(refusedForGood)
    const run = signIn({ holdConsentRead: 2, stored: expiredSession(), fetcher })
    await waitFor(run.events, "consent:held")
    const before = await run.inner.read()
    run.failGenerationWrite()

    await expect(run.service.models()).rejects.toThrow("The write failed")
    const after = await run.inner.read()

    // Only the mark that the refresh began was saved; the generation, the credentials and the
    // sign-in's own record are exactly as they were.
    expect(after).toEqual({ ...before, refreshing: true })
    run.releaseConsent()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate when the session ended while the last vault read was still returning", async () => {
    // The ownership is taken before that read begins, not when it returns: a read that began first
    // may still answer with the record as it was, and the end of the session lands in between.
    const fetcher = tokenEndpoint(refusedForGood)
    const lastRead = await vaultReadsBeforeNavigation({ stored: expiredSession() })
    const run = signIn({
      holdVaultRead: lastRead,
      snapshotBeforeHold: true,
      stored: expiredSession(),
      fetcher,
    })
    await waitFor(run.events, "vault:held")

    await expect(run.service.models()).rejects.toMatchObject({ code: "invalid_grant" })
    run.releaseVault()

    expect(await run.started).toMatchObject({ code: "session_changed" })
    expect(run.transport.navigate).not.toHaveBeenCalled()
  })

  it("navigates when a refresh failed for a reason that leaves the session in place", async () => {
    // The control for the two above: the same operation, but the generation does not move.
    const fetcher = tokenEndpoint(unavailable)
    const run = signIn({ holdConsentRead: 2, stored: expiredSession(), fetcher })
    await waitFor(run.events, "consent:held")
    const before = await run.inner.read()

    await expect(run.service.models()).rejects.toMatchObject({ code: "server_error" })
    expect((await run.inner.read()).generation).toBe(before.generation)
    run.releaseConsent()

    expect(await run.started).toBe("navigated")
    expect(run.transport.navigate).toHaveBeenCalledTimes(1)
  })
})
