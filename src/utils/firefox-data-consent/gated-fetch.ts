import type { DataConsentCategory } from "./errors"
import { requestCarriesCredentials } from "./credentials"
import { assertDataConsentAll, isDataConsentBuild } from "./status"

export interface ConsentGatedFetchOptions {
  /**
   * The caller knows the requests carry a credential the request itself does not show (a key
   * inside a DeepLX URL path, the user's declaration, an API key the SDK has not put in a header
   * yet). The gate then applies without looking at the request.
   */
  credentialed?: boolean
  /**
   * Optional categories every request through this fetch sends besides credentials (the page URL:
   * browsingActivity). They are read at each call, together with the credential check.
   */
  categories?: readonly DataConsentCategory[]
}

/**
 * Wraps a `fetch` so a request starts only while Firefox's consent holds for everything it sends:
 * `authenticationInfo` when it carries a credential, and each category the caller declared for it.
 * The grant is read for every call, so an SDK retry or a queue retry after a revocation is refused
 * too; a request that already started is not touched. The check is the last thing before the inner
 * fetch, outside usage metering. A request that sends none of these, and every request on a Chrome
 * build, goes straight through without asking the browser.
 */
export function createConsentGatedFetch(
  inner: typeof fetch,
  options: ConsentGatedFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    if (isDataConsentBuild()) {
      const needed = new Set<DataConsentCategory>(options.categories)
      if (options.credentialed || requestCarriesCredentials(input, init)) {
        needed.add("authenticationInfo")
      }
      // Credentials first, so the refusal names the one the user most likely meets first.
      await assertDataConsentAll(
        (["authenticationInfo", "browsingActivity"] as const).filter((category) =>
          needed.has(category),
        ),
      )
    }
    return inner(input, init)
  }
}
