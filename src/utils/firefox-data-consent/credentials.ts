import { isCredentialName } from "@/utils/config/api"

/**
 * What counts as an explicit credential. The rule is the one the config export already applies to
 * names: `isCredentialName` (authorization, proxy-authorization, cookie, x-api-key, api-key, and
 * anything with token, secret, key or auth in its name). Version and content headers do not count.
 * A request that asks the browser to attach its stored cookies (`credentials: "include"`) counts too,
 * because those cookies never show in the headers the caller supplied.
 *
 * What it cannot see, stated plainly: a secret in an opaque URL path segment, in an option whose
 * name looks innocent, or in a header with an unrecognised name travels without tripping the gate.
 * The provider setting `endpointNeedsConsent` ("this endpoint URL or its options contain a secret")
 * exists for exactly those, and defaults to off.
 */

export const API_KEY_PLACEHOLDER = "{{apiKey}}"

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value).length === 0
  return false
}

/** A header is a credential when its name is one and a value is actually sent. */
export function headersCarryCredentials(headers: HeadersInit | undefined | null): boolean {
  if (!headers) return false
  let pairs: Array<[string, string]>
  try {
    pairs = [...new Headers(headers).entries()]
  } catch {
    return false
  }
  return pairs.some(([name, value]) => value.trim() !== "" && isCredentialName(name))
}

/** Userinfo, or a credential-named query parameter with a value, read with the native URL parser. */
export function urlCarriesCredentials(url: string | URL | undefined | null): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return true
  for (const [name, value] of parsed.searchParams) {
    if (value !== "" && isCredentialName(name)) return true
  }
  return false
}

/**
 * Whether the request asks the browser to attach its own stored credentials (cookies) to it. Only
 * `include` does. `omit` attaches none, and the default `same-origin` attaches them only to a
 * request to the caller's own origin: every other site is cross-origin for the extension, and the
 * extension's own pages hold no cookies for a provider. The init overrides the Request, as `fetch`
 * does, so `omit` in the init wins over `include` on the Request and the other way round.
 */
function requestAsksForCookies(input: RequestInfo | URL, init?: RequestInit): boolean {
  const fromRequest =
    typeof input === "string" || input instanceof URL ? undefined : input.credentials
  return (init?.credentials ?? fromRequest) === "include"
}

/** The request that is about to leave: its URL, every header that goes with it, and its cookie mode. */
export function requestCarriesCredentials(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = typeof input === "string" || input instanceof URL ? input : input.url
  const requestHeaders =
    typeof input === "string" || input instanceof URL ? undefined : input.headers
  return (
    urlCarriesCredentials(url) ||
    headersCarryCredentials(init?.headers) ||
    headersCarryCredentials(requestHeaders) ||
    requestAsksForCookies(input, init)
  )
}

const MAX_OPTION_DEPTH = 4

/** A shallow scan of option NAMES: a credential-named option with something in it is a credential. */
export function optionsCarryCredentials(options: unknown, depth = 0): boolean {
  if (depth >= MAX_OPTION_DEPTH || options === null || typeof options !== "object") return false
  return Object.entries(options).some(([name, value]) => {
    if (isCredentialName(name) && !isBlank(value)) return true
    return optionsCarryCredentials(value, depth + 1)
  })
}

/** The parts of a provider config that decide whether its requests carry a credential. */
export interface ProviderCredentialSource {
  apiKey?: string
  baseURL?: string
  url?: string
  providerOptions?: Record<string, unknown>
  /** The user's own declaration. It only adds to what is detected; it never removes anything. */
  endpointNeedsConsent?: boolean
}

/**
 * Whether requests for this provider carry an explicit credential: a non-empty key, a `{{apiKey}}`
 * placeholder or credentials in the endpoint URL, a credential-named header among the headers that
 * are actually transmitted (`effectiveHeaders`, with empty values already left out), a
 * credential-named option, or the user's declaration. Switching the declaration off lifts nothing
 * that is detected.
 */
export function providerConfigCarriesCredentials(
  config: ProviderCredentialSource,
  effectiveHeaders?: Record<string, string>,
): boolean {
  if (config.apiKey?.trim()) return true
  if (config.endpointNeedsConsent === true) return true
  for (const endpoint of [config.baseURL, config.url]) {
    if (endpoint?.includes(API_KEY_PLACEHOLDER) || urlCarriesCredentials(endpoint)) return true
  }
  if (effectiveHeaders && headersCarryCredentials(effectiveHeaders)) return true
  return optionsCarryCredentials(config.providerOptions)
}
