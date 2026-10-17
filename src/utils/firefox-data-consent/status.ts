import type { DataConsentCategory } from "./errors"
import { browser } from "wxt/browser"
import { DataConsentRequiredError } from "./errors"

export type DataConsentStatus = "not-applicable" | "granted" | "denied" | "unsupported"

/**
 * Only the Firefox build is gated. Chrome's user-data policy is met by disclosure, so a Chrome build
 * never asks the browser anything. `BROWSER` is the build target WXT sets (and tests stub).
 */
export function isDataConsentBuild(): boolean {
  return import.meta.env.BROWSER === "firefox"
}

interface DataCollectionPermissions {
  data_collection?: unknown
}

/**
 * Where the user's grant stands right now, read from the browser every time, never cached: a
 * revocation in about:addons has to stop the next transmission.
 *
 * On Firefox 140+ `permissions.getAll().data_collection` lists the optional categories the user has
 * granted. The key is present on a browser with built-in consent (an empty list when nothing is
 * granted) and absent on one without it; the optional categories then fail closed. A browser that
 * cannot be asked is treated the same way.
 */
export async function getDataConsentStatus(
  category: DataConsentCategory,
): Promise<DataConsentStatus> {
  if (!isDataConsentBuild()) return "not-applicable"
  let reported: unknown
  try {
    const all = (await browser.permissions.getAll()) as DataCollectionPermissions
    reported = all?.data_collection
  } catch {
    return "unsupported"
  }
  if (!Array.isArray(reported)) return "unsupported"
  return reported.includes(category) ? "granted" : "denied"
}

/** Resolves when a new transmission of `category` may start; rejects with a typed refusal if not. */
export async function assertDataConsent(category: DataConsentCategory): Promise<void> {
  const status = await getDataConsentStatus(category)
  if (status === "denied" || status === "unsupported") {
    throw new DataConsentRequiredError(category, status)
  }
}

/**
 * Asks Firefox for the category. Call it only from a user-gesture handler, and call it before any
 * `await` in that handler: the request must start in the turn of the click. It is not an `async`
 * function and does not read `getAll` first, for the same reason. A browser without built-in consent
 * rejects the request, which is reported as "not granted".
 */
export function requestDataConsent(category: DataConsentCategory): Promise<boolean> {
  if (!isDataConsentBuild()) return Promise.resolve(true)
  try {
    const asked = browser.permissions.request({
      data_collection: [category],
    } as unknown as Parameters<typeof browser.permissions.request>[0])
    return Promise.resolve(asked).then(Boolean, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * Tells a settings page that a grant changed. Mozilla documents `permissions.onAdded` and
 * `onRemoved` but does not say they fire for a switch in about:addons, so a page uses this only to
 * refresh what it shows. Every dispatch still reads the browser itself. Returns an unsubscribe.
 */
export function watchDataConsent(onChange: () => void): () => void {
  if (!isDataConsentBuild()) return () => {}
  const events = [browser.permissions?.onAdded, browser.permissions?.onRemoved].filter(Boolean)
  for (const event of events) event.addListener(onChange)
  return () => {
    for (const event of events) event.removeListener(onChange)
  }
}
