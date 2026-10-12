import type { ApiUsageFeature, ApiUsageTransport } from "./api-usage"

type Observer = (feature: ApiUsageFeature, transport: ApiUsageTransport) => void
let observer: Observer | undefined

/** Installed only by the background; model checks in settings stay unmetered. */
export function installApiUsageObserver(callback: Observer) {
  observer = callback
}

export function recordApiUsageAttempt(feature: ApiUsageFeature, transport: ApiUsageTransport) {
  try {
    observer?.(feature, transport)
  } catch {
    // Observability must never fail a provider request. No request/error logging.
  }
}

/** Observe fetch dispatch only. Never read/clone bodies, responses, headers or URLs. */
export function withApiUsage(
  feature: ApiUsageFeature,
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
): typeof fetch {
  return (input, init) => {
    const signal =
      init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
    if (!signal?.aborted) recordApiUsageAttempt(feature, "api")
    return fetcher(input, init)
  }
}
