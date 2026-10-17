// A stand-in for the browser's built-in data consent, for tests that run in the Chrome-flavoured
// test environment.
//
// `import.meta.env.BROWSER` is "chrome" under vitest. `installFirefox` stubs it to "firefox" and
// replaces the three `browser.permissions` calls the consent code may use. What Firefox 140+
// reports for the add-on is `permissions.getAll().data_collection`: the categories that are in
// force, always including the required ones. The key is absent on a browser without built-in
// consent. Nothing here asks a real browser anything.

import type { Mock } from "vitest"
import { vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"

/** What `permissions.getAll().data_collection` holds; `undefined` is "the key is absent". */
export type ReportedDataCollection = readonly string[] | undefined

interface DataCollectionRequest {
  permissions?: string[]
  origins?: string[]
  data_collection?: string[]
}

interface FakePermissions {
  getAll: () => Promise<unknown>
  contains: (request: DataCollectionRequest) => Promise<boolean>
  request: (request: DataCollectionRequest) => Promise<boolean>
}

export interface PermissionsDouble {
  /** Change what the browser reports from now on (a grant, or a revocation in about:addons). */
  report: (next: ReportedDataCollection) => void
  /** Decide the answer of the next user prompts; granting adds the categories to the report. */
  answerPrompts: (grant: boolean) => void
  getAll: Mock<FakePermissions["getAll"]>
  contains: Mock<FakePermissions["contains"]>
  request: Mock<FakePermissions["request"]>
  /** Every call that went to the browser, so a test can prove none did. */
  readonly browserCalls: () => number
}

function install(initial: ReportedDataCollection): PermissionsDouble {
  const permissions = fakeBrowser.permissions as unknown as FakePermissions
  let reported = initial
  let grantPrompts = false

  const getAll = vi.spyOn(permissions, "getAll").mockImplementation(async () => ({
    permissions: [],
    origins: [],
    ...(reported ? { data_collection: [...reported] } : {}),
  }))
  const contains = vi.spyOn(permissions, "contains").mockImplementation(async (request) => {
    if (!request.data_collection) return true
    const current = reported
    return !!current && request.data_collection.every((category) => current.includes(category))
  })
  const request = vi.spyOn(permissions, "request").mockImplementation(async (asked) => {
    if (!asked.data_collection || !grantPrompts) return false
    reported = [...new Set([...(reported ?? []), ...asked.data_collection])]
    return true
  })

  return {
    report: (next) => {
      reported = next
    },
    answerPrompts: (grant) => {
      grantPrompts = grant
    },
    getAll,
    contains,
    request,
    browserCalls: () =>
      getAll.mock.calls.length + contains.mock.calls.length + request.mock.calls.length,
  }
}

/** A Firefox build with built-in consent: `reported` is what the add-on holds right now. */
export function installFirefox(
  reported: ReportedDataCollection = ["websiteContent"],
): PermissionsDouble {
  vi.stubEnv("BROWSER", "firefox")
  return install(reported)
}

/** A Chrome build. The permissions calls are watched, because nothing may ask them anything. */
export function installChrome(): PermissionsDouble {
  vi.stubEnv("BROWSER", "chrome")
  return install(undefined)
}

export function removePermissionsDouble() {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
}

export const REQUIRED_ONLY: ReportedDataCollection = ["websiteContent"]
export const WITH_CREDENTIALS: ReportedDataCollection = ["websiteContent", "authenticationInfo"]
export const WITH_PAGE_URL: ReportedDataCollection = ["websiteContent", "browsingActivity"]
export const WITH_ALL: ReportedDataCollection = [
  "websiteContent",
  "authenticationInfo",
  "browsingActivity",
]
