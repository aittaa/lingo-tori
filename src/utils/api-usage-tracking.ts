import type { ApiUsageFeature, ApiUsageTransport } from "./api-usage"
import type { ApiUsageIdentity } from "./api-usage-identity"
import type { ReportedTokens } from "./api-usage-tokens"
import { getApiUsageModelIdentity } from "./api-usage-identity"
import { readSdkTokens } from "./api-usage-tokens"

type Observer = (
  feature: ApiUsageFeature,
  transport: ApiUsageTransport,
  identity?: ApiUsageIdentity,
) => void
let observer: Observer | undefined
let resultObserver:
  | ((feature: ApiUsageFeature, identity: ApiUsageIdentity, tokens: ReportedTokens) => void)
  | undefined
export function installApiUsageResultObserver(callback: typeof resultObserver) {
  resultObserver = callback
}

export function createApiUsageReporter(model: unknown, feature?: ApiUsageFeature) {
  const identity = getApiUsageModelIdentity(model)
  let tokens: ReportedTokens = {}
  let finished = false
  return {
    observe(value: unknown) {
      try {
        tokens = readSdkTokens(value)
      } catch {
        /* Numeric metadata must not affect output. */
      }
    },
    finish() {
      if (finished) return
      finished = true
      if (!feature || !identity) return
      try {
        resultObserver?.(feature, identity, tokens)
      } catch {
        /* No logging or request failure. */
      }
    },
  }
}

/** Installed only by the background; model checks in settings stay unmetered. */
export function installApiUsageObserver(callback: Observer) {
  observer = callback
}

export function recordApiUsageAttempt(
  feature: ApiUsageFeature,
  transport: ApiUsageTransport,
  identity?: ApiUsageIdentity,
) {
  try {
    if (identity) observer?.(feature, transport, identity)
    else observer?.(feature, transport)
  } catch {
    // Observability must never fail a provider request. No request/error logging.
  }
}

/** Observe fetch dispatch only. Never read/clone bodies, responses, headers or URLs. */
export function withApiUsage(
  feature: ApiUsageFeature,
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
  identity?: ApiUsageIdentity,
): typeof fetch {
  return (input, init) => {
    const signal =
      init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
    if (!signal?.aborted) recordApiUsageAttempt(feature, "api", identity)
    return fetcher(input, init)
  }
}
