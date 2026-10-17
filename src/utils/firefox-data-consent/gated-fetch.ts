import { requestCarriesCredentials } from "./credentials"
import { assertDataConsent, isDataConsentBuild } from "./status"

export interface ConsentGatedFetchOptions {
  /**
   * The caller knows the requests carry a credential the request itself does not show (a key
   * inside a DeepLX URL path, the user's declaration, an API key the SDK has not put in a header
   * yet). The gate then applies without looking at the request.
   */
  credentialed?: boolean
}

/**
 * Wraps a `fetch` so a request that carries a credential starts only while Firefox's
 * `authenticationInfo` consent is granted. The grant is read for every call, so an SDK retry or a
 * queue retry after a revocation is refused too; a request that already started is not touched.
 * The check is the last thing before the inner fetch. A request without a credential, and every
 * request on a Chrome build, goes straight through without asking the browser.
 */
export function createConsentGatedFetch(
  inner: typeof fetch,
  options: ConsentGatedFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    if (isDataConsentBuild() && (options.credentialed || requestCarriesCredentials(input, init))) {
      await assertDataConsent("authenticationInfo")
    }
    return inner(input, init)
  }
}
