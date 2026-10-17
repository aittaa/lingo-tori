/** The optional data categories this extension asks Firefox for. Required ones are never gated. */
export type DataConsentCategory = "authenticationInfo" | "browsingActivity"

/**
 * What a request tells the code that builds its model and sends it, beside the provider's own
 * payload: the optional categories the request sends (the page URL, say). Internal runtime options,
 * never part of what is sent to the provider. Each of them is checked again at every dispatch.
 */
export interface ConsentRuntimeOptions {
  dataCategories?: readonly DataConsentCategory[]
}

export const DATA_CONSENT_CATEGORIES = [
  "authenticationInfo",
  "browsingActivity",
] as const satisfies readonly DataConsentCategory[]

/**
 * - `denied`: Firefox supports built-in consent and the user has not granted the category (or has
 *   switched it off in about:addons).
 * - `unsupported`: the browser reports no built-in consent, or cannot be asked. The optional
 *   categories fail closed.
 */
export type DataConsentRefusalReason = "denied" | "unsupported"

export const DATA_CONSENT_REQUIRED_ERROR_NAME = "DataConsentRequiredError"

const WHAT_IT_SENDS: Record<DataConsentCategory, string> = {
  authenticationInfo: "your API key or sign-in credentials",
  browsingActivity: "the address of the current page",
}

const WHERE_TO_ALLOW: Record<DataConsentCategory, string> = {
  authenticationInfo: "allow it in LingoTori settings (API providers or ChatGPT sign-in)",
  browsingActivity: "allow it in LingoTori settings (custom actions)",
}

function describeRefusal(category: DataConsentCategory, reason: DataConsentRefusalReason) {
  if (reason === "unsupported") {
    return (
      `Firefox data consent is not available in this browser, so LingoTori does not send ` +
      `${WHAT_IT_SENDS[category]}. Update Firefox to version 140 or later.`
    )
  }
  return (
    `Firefox data consent is required: this request would send ${WHAT_IT_SENDS[category]} ` +
    `to your provider. To continue, ${WHERE_TO_ALLOW[category]}.`
  )
}

/**
 * A new transmission was refused because Firefox's built-in data consent does not cover it.
 *
 * It is a final answer, not a transient failure. `isRetryable` and `kind` are read by the request
 * queue's retry policy: without them an unknown error is retried with backoff, and the retries only
 * ask again. The message deliberately avoids the words the queue reads as a network failure, a
 * timeout or a rate limit. The error is recognised by `name` (see `isDataConsentRequiredError`),
 * which is what survives extension messaging.
 */
export class DataConsentRequiredError extends Error {
  readonly category: DataConsentCategory
  readonly reason: DataConsentRefusalReason
  readonly isRetryable = false
  readonly kind = "access-denied"

  constructor(category: DataConsentCategory, reason: DataConsentRefusalReason) {
    super(describeRefusal(category, reason))
    this.name = DATA_CONSENT_REQUIRED_ERROR_NAME
    this.category = category
    this.reason = reason
  }
}

/** By name, so it also holds for an error that crossed extension messaging as a plain object. */
export function isDataConsentRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === DATA_CONSENT_REQUIRED_ERROR_NAME
  )
}

const MAX_CAUSE_DEPTH = 5

/**
 * The refusal inside a wrapper: the AI SDK wraps an error from a later retry attempt in a retry
 * error (`lastError`, `errors`), and a stream error is re-thrown with the original as its `cause`.
 */
export function findDataConsentError(
  error: unknown,
  depth = 0,
): DataConsentRequiredError | undefined {
  if (depth >= MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) return undefined
  if (isDataConsentRequiredError(error)) return error as DataConsentRequiredError
  const wrapped = error as { cause?: unknown; lastError?: unknown; errors?: unknown }
  const candidates = [
    wrapped.cause,
    wrapped.lastError,
    ...(Array.isArray(wrapped.errors) ? wrapped.errors : []),
  ]
  for (const candidate of candidates) {
    const found = findDataConsentError(candidate, depth + 1)
    if (found) return found
  }
  return undefined
}
