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

function isCredentialName(name: string): boolean {
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

// A stand-in for `{{apiKey}}` while a string goes through the URL parser: lower-case letters only,
// so no component rewrites it, and nothing the credential-name rule would match. It is made not to
// occur in the text in any case, so putting `{{apiKey}}` back cannot touch anything else.
function placeholderSentinel(text: string): string {
  const lower = text.toLowerCase()
  let sentinel = "zqplaceholderzq"
  while (lower.includes(sentinel)) sentinel += "q"
  return sentinel
}

const isLiteral = (value: string, sentinel: string) => value !== "" && value !== sentinel

function hasCredentialParams(params: URLSearchParams, sentinel: string): boolean {
  for (const [name, value] of params) {
    if (isLiteral(value, sentinel) && isCredentialName(name)) return true
  }
  return false
}

function withoutCredentialValues(params: URLSearchParams, sentinel: string): URLSearchParams {
  const result = new URLSearchParams()
  for (const [name, value] of params) {
    result.append(name, isLiteral(value, sentinel) && isCredentialName(name) ? "" : value)
  }
  return result
}

function hasUserinfo(url: URL, sentinel: string): boolean {
  return isLiteral(url.username, sentinel) || isLiteral(url.password, sentinel)
}

function fragmentParams(url: URL): URLSearchParams | undefined {
  const fragment = url.hash.slice(1)
  return fragment.includes("=") ? new URLSearchParams(fragment) : undefined
}

// What the URL parser reads as a credential, which is what the text can hide: whitespace and extra
// slashes before the authority, backslashes for slashes, and tabs or newlines inside a name.
function hasParsedCredentials(url: URL, sentinel: string): boolean {
  const fragment = fragmentParams(url)
  return (
    hasUserinfo(url, sentinel) ||
    hasCredentialParams(url.searchParams, sentinel) ||
    (fragment !== undefined && hasCredentialParams(fragment, sentinel))
  )
}

function stripParsedCredentials(url: URL, sentinel: string): void {
  if (hasUserinfo(url, sentinel)) {
    url.username = ""
    url.password = ""
  }
  if (hasCredentialParams(url.searchParams, sentinel)) {
    url.search = withoutCredentialValues(url.searchParams, sentinel).toString()
  }
  const fragment = fragmentParams(url)
  if (fragment && hasCredentialParams(fragment, sentinel)) {
    url.hash = withoutCredentialValues(fragment, sentinel).toString()
  }
}

// The text pass, then the way `fetch` reads the string. A URL that still has a credential once
// parsed is rebuilt from the parsed form with it removed, and checked again: if one survives the
// rebuild this throws, so the export is not written. A string with nothing left to remove comes
// back exactly as it went in, and one that is not a URL gets the text pass only.
function redactUrlCredentials(url: string): string {
  const textual = redactUrlText(url)
  const sentinel = placeholderSentinel(textual)
  const protect = (text: string) => text.replaceAll(API_KEY_PLACEHOLDER, sentinel)

  const parsed = parseUrl(protect(textual))
  if (!parsed || !hasParsedCredentials(parsed, sentinel)) return textual

  stripParsedCredentials(parsed, sentinel)
  const rebuilt = parsed.href.replaceAll(sentinel, API_KEY_PLACEHOLDER)

  const check = parseUrl(protect(rebuilt))
  if (!check || hasParsedCredentials(check, sentinel)) {
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
