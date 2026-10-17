import { getRandomUUID } from "@/utils/crypto-polyfill"

const API_KEY_PLACEHOLDER = "{{apiKey}}"

// What names a credential. The decision is made on the lower-cased name, never on where the case
// changes, so `accessToken`, `accesstoken` and `ACCESSTOKEN` are the same name.
// `key` is in because `x-api-key`, `?key=` and `subscriptionKey` are credentials; it also takes
// `cacheKey`, and a credential-free export may lose a harmless setting to be sure. The few words that
// only contain it (`keyboard`) are left out.
// `token` must not be followed by `s` or `iz`, so `maxTokens`, `budgetTokens` and `tokenizer` survive.
// `auth` must not be followed by `or`, so `author` survives; `authorization` is matched on its own.
// They run on the name with its separators removed (`x-api-key` is `xapikey`).
const CREDENTIAL_PATTERNS = [
  /key(?!board|pad|note|word|frame|stone|stroke)/,
  /token(?!s|iz)/,
  /auth(?!or)/,
  /authorization|bearer|secret|password|passwd|credential|cookie|signature|jwt|header/,
]

// Short enough to be a whole word only: `sig` is a signature, `design` and `assign` are not.
const CREDENTIAL_WORD_SUFFIXES = ["sig", "pwd"]

export function isCredentialName(name: string): boolean {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const joined = words.join("")
  return (
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(joined)) ||
    words.some((word) => CREDENTIAL_WORD_SUFFIXES.some((suffix) => word.endsWith(suffix)))
  )
}

function isUrlName(name: string): boolean {
  const joined = name.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  return joined.endsWith("url") || joined.endsWith("uri") || joined.includes("endpoint")
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

// `name=value` pairs, as in a query or a fragment. Only the value of a credential-named pair
// changes, and not when it is just the placeholder. Everything else stays as typed.
function redactPairs(pairs: string): string {
  return pairs
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=")
      if (equals === -1) return pair
      const value = pair.slice(equals + 1)
      if (value === "" || value === API_KEY_PLACEHOLDER) return pair
      const name = pair.slice(0, equals)
      return isCredentialName(decodeName(name)) ? `${name}=` : pair
    })
    .join("&")
}

// The textual pass. What a URL can carry: userinfo (`https://user:pass@host`) and the value of a
// credential-named query or fragment parameter. A key typed into the path cannot be told from a
// path segment, so the path is never touched. It reads the string as typed, which is not always how
// a browser reads it, so `redactUrlCredentials` checks the result again with the URL parser.
function redactUrlText(url: string): string {
  const withoutUserinfo = url.replace(
    /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/?#]*)@/i,
    (match, prefix: string, userinfo: string) =>
      userinfo.split(":").every((part) => part === "" || part === API_KEY_PLACEHOLDER)
        ? match
        : prefix,
  )

  const hashAt = withoutUserinfo.indexOf("#")
  const beforeHash = hashAt === -1 ? withoutUserinfo : withoutUserinfo.slice(0, hashAt)
  const queryAt = beforeHash.indexOf("?")

  let result = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
  if (queryAt !== -1) {
    result += `?${redactPairs(beforeHash.slice(queryAt + 1))}`
  }
  if (hashAt !== -1) {
    const hash = withoutUserinfo.slice(hashAt + 1)
    result += `#${hash.includes("=") ? redactPairs(hash) : hash}`
  }
  return result
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

// A stand-in for `{{apiKey}}` while a string goes through the URL parser. It is made up per call
// from random bytes (a fixed prefix and 32 hex digits), in lower-case letters and digits that no URL
// component rewrites. Nobody can spell it, so the parser cannot assemble it out of other text by
// dropping tabs and newlines, decoding percent-escapes or mapping fullwidth letters. That is
// checked, not assumed: see `redactUrlCredentials`.
function newPlaceholderStandIn(): string {
  return `zqph${getRandomUUID().replaceAll("-", "")}`
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function decodeText(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// How many stand-ins a parsed URL holds in the forms the credential check reads it in, all through
// the platform: the decoded userinfo and path, the host, and every name and value of the query and
// of a `name=value` fragment as `URLSearchParams` decodes them. The href keeps escapes as they were
// written, so a stand-in spelled with `%70` is in none of its text but is in a decoded value.
function decodedStandInCount(url: URL, standIn: string): number {
  let total =
    countOf(decodeText(url.username), standIn) +
    countOf(decodeText(url.password), standIn) +
    countOf(url.hostname, standIn) +
    countOf(decodeText(url.pathname), standIn)
  for (const [name, value] of new URLSearchParams(url.search)) {
    total += countOf(name, standIn) + countOf(value, standIn)
  }
  const fragment = fragmentParams(url)
  if (fragment) {
    for (const [name, value] of fragment) total += countOf(name, standIn) + countOf(value, standIn)
  }
  return total
}

// The stand-in count the parser reports must be exactly the number of `{{apiKey}}` that went in,
// both in the serialized URL and in the decoded forms above. A surplus means the parser made one
// out of other text, a shortfall that one was dropped; either way the URL is not what was written.
function standInCountIs(url: URL, standIn: string, expected: number): boolean {
  return countOf(url.href, standIn) === expected && decodedStandInCount(url, standIn) === expected
}

const isLiteral = (value: string, standIn: string) => value !== "" && value !== standIn

function hasCredentialParams(params: URLSearchParams, standIn: string): boolean {
  for (const [name, value] of params) {
    if (isLiteral(value, standIn) && isCredentialName(name)) return true
  }
  return false
}

function withoutCredentialValues(params: URLSearchParams, standIn: string): URLSearchParams {
  const result = new URLSearchParams()
  for (const [name, value] of params) {
    result.append(name, isLiteral(value, standIn) && isCredentialName(name) ? "" : value)
  }
  return result
}

function hasUserinfo(url: URL, standIn: string): boolean {
  return isLiteral(url.username, standIn) || isLiteral(url.password, standIn)
}

function fragmentParams(url: URL): URLSearchParams | undefined {
  const fragment = url.hash.slice(1)
  return fragment.includes("=") ? new URLSearchParams(fragment) : undefined
}

// What the URL parser reads as a credential, which is what the text can hide: whitespace and extra
// slashes before the authority, backslashes for slashes, and tabs or newlines inside a name.
function hasParsedCredentials(url: URL, standIn: string): boolean {
  const fragment = fragmentParams(url)
  return (
    hasUserinfo(url, standIn) ||
    hasCredentialParams(url.searchParams, standIn) ||
    (fragment !== undefined && hasCredentialParams(fragment, standIn))
  )
}

function stripParsedCredentials(url: URL, standIn: string): void {
  if (hasUserinfo(url, standIn)) {
    url.username = ""
    url.password = ""
  }
  if (hasCredentialParams(url.searchParams, standIn)) {
    url.search = withoutCredentialValues(url.searchParams, standIn).toString()
  }
  const fragment = fragmentParams(url)
  if (fragment && hasCredentialParams(fragment, standIn)) {
    url.hash = withoutCredentialValues(fragment, standIn).toString()
  }
}

// The text pass, then the way `fetch` reads the string. A URL that still has a credential once
// parsed is rebuilt from the parsed form with it removed, and checked again: if one survives the
// rebuild this throws, so the export is not written. A string with nothing left to remove comes
// back exactly as it went in, and one that is not a URL gets the text pass only.
//
// `{{apiKey}}` is swapped for a random stand-in around the parser, and only a value that IS the
// stand-in is taken for a placeholder. The stand-in count is checked as a total, not per component:
// a manufactured one raises it, a dropped placeholder lowers it, and both at once would need the
// random stand-in to collide. After the rebuild the result is read again with a fresh stand-in.
function redactUrlCredentials(url: string): string {
  const textual = redactUrlText(url)
  const written = countOf(textual, API_KEY_PLACEHOLDER)
  const standIn = newPlaceholderStandIn()
  const protect = (text: string, replacement: string) =>
    text.replaceAll(API_KEY_PLACEHOLDER, replacement)

  const parsed = parseUrl(protect(textual, standIn))
  if (!parsed) return textual

  if (!standInCountIs(parsed, standIn, written)) {
    throw new Error("A provider URL does not keep its {{apiKey}} placeholders as they were written")
  }
  if (!hasParsedCredentials(parsed, standIn)) return textual

  // A host label that holds the placeholder and is not plain ASCII is converted to punycode with
  // the stand-in inside it, and `{{apiKey}}` put back there would not be the host that was written.
  if (parsed.hostname.includes(standIn) && /(^|\.)xn--/.test(parsed.hostname)) {
    throw new Error(
      "A provider URL has an {{apiKey}} placeholder in an internationalized host name",
    )
  }
  const hostname = parsed.hostname.replaceAll(standIn, API_KEY_PLACEHOLDER)
  stripParsedCredentials(parsed, standIn)
  const rebuilt = parsed.href.replaceAll(standIn, API_KEY_PLACEHOLDER)

  // Only credentials leave, and with them any placeholder written inside one: never a new one.
  const remaining = countOf(rebuilt, API_KEY_PLACEHOLDER)
  const fresh = newPlaceholderStandIn()
  const check = parseUrl(protect(rebuilt, fresh))
  if (
    remaining > written ||
    !check ||
    !standInCountIs(check, fresh, remaining) ||
    hasParsedCredentials(check, fresh) ||
    check.hostname.replaceAll(fresh, API_KEY_PLACEHOLDER) !== hostname
  ) {
    throw new Error("Could not remove the credentials from a provider URL")
  }
  return rebuilt
}

function redactCredentials(value: unknown, inProviders: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentials(item, inProviders))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === "apiKey" || (inProviders && isCredentialName(key))) {
        continue
      }
      result[key] =
        inProviders && typeof child === "string" && isUrlName(key)
          ? redactUrlCredentials(child)
          : redactCredentials(child, inProviders || key === "providersConfig")
    }
    return result
  }
  return value
}

/**
 * A copy of the config that is safe to hand to someone else, for the "exclude API keys" export.
 *
 * Provider settings (everything under `providersConfig`) carry credentials in more places than
 * `apiKey`, and the schema accepts all of them:
 * - `headers` is a free `Record<string, any>` sent verbatim on every request, so a header under any
 *   name can be the credential. The whole object goes.
 * - `providerOptions` is a free object too. Entries named like a credential go, at any depth.
 * - `baseURL` and `url` can hold userinfo or a credential-named parameter. Those are removed, in the
 *   forms the text shows and in the ones only the URL parser sees (padding, extra slashes, tabs in a
 *   name), and a `{{apiKey}}` placeholder stays as typed, so a DeepLX URL works again once the key
 *   is re-entered.
 *
 * A property named `apiKey` goes wherever it sits, as it always did. Nothing outside provider
 * settings held another credential when this was written (a test keeps that true), so the rest of
 * the config is copied as it is.
 *
 * It throws when it cannot finish and never returns the original: an export that cannot be cleaned
 * must not be written. `getObjectWithoutAPIKeys` below still falls back to the original, because
 * its other caller only wants a cache key.
 */
export function getConfigWithoutCredentials<T extends Record<string, any>>(config: T): T {
  return redactCredentials(config, false) as T
}

// Removes only properties named exactly `apiKey`, and returns the input if that fails. That is
// enough for keeping a key out of a cache key, and not for an export: use
// getConfigWithoutCredentials there.
export function getObjectWithoutAPIKeys<T extends Record<string, any>>(originalObject: T): T {
  function deepClean(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(deepClean)
    }
    if (obj && typeof obj === "object") {
      const newObj: Record<string, any> = {}
      for (const key in obj) {
        if (key === "apiKey") {
          continue
        }
        newObj[key] = deepClean(obj[key])
      }
      return newObj
    }
    return obj
  }

  try {
    return deepClean(originalObject)
  } catch {
    return originalObject
  }
}

export function hasAPIKey(obj: any): boolean {
  function deepCheck(value: any): boolean {
    if (Array.isArray(value)) {
      return value.some(deepCheck)
    }
    if (value && typeof value === "object") {
      for (const key in value) {
        if (key === "apiKey" && value[key]) {
          return true
        }
        if (deepCheck(value[key])) {
          return true
        }
      }
    }
    return false
  }

  try {
    return deepCheck(obj)
  } catch {
    return false
  }
}
