import type { ApiUsageFeature } from "@/utils/api-usage"
import type { ApiUsageIdentity } from "@/utils/api-usage-identity"
import { withApiUsage } from "@/utils/api-usage-tracking"
import { createConsentGatedFetch } from "@/utils/firefox-data-consent"
import { noStoreFetch } from "./no-store-fetch"

/**
 * The `fetch` for a provider request: no-store caching, usage metering, and Firefox's data consent.
 *
 * The consent check wraps the metering, so a request that is refused is never counted as an API
 * dispatch: metering runs only after the request has been admitted. It runs again for every call,
 * so an SDK retry or a queue retry after a revocation is refused as well.
 *
 * `credentialed` is what the caller knows from the provider's configuration (an API key, a
 * placeholder, a declared endpoint); the gate also reads the headers and URL of the request itself.
 */
export function createProviderFetch({
  feature,
  identity,
  credentialed,
}: {
  feature?: ApiUsageFeature
  identity?: ApiUsageIdentity
  credentialed: boolean
}): typeof fetch {
  const metered = feature ? withApiUsage(feature, noStoreFetch, identity) : noStoreFetch
  return createConsentGatedFetch(metered, { credentialed })
}
