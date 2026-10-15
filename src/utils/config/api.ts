const API_KEY_PLACEHOLDER = "{{apiKey}}"

// Whole words (a name is split on case changes and non-alphanumerics) that name a credential.
// `key` is here because `x-api-key`, `?key=` and `subscriptionKey` are credentials. It also takes
// `cacheKey`, and a credential-free export may lose a harmless setting to be sure.
// `token` is singular on purpose, so `maxTokens` and `budgetTokens` survive.
const CREDENTIAL_WORDS = new Set([
  "key",
  "keys",
  "token",
  "auth",
  "oauth",
  "bearer",
  "pwd",
  "sig",
  "signature",
  "jwt",
  "header",
  "headers",
])

// Credential names that run into other words (`xapikey`, `clientsecret`).
const CREDENTIAL_SUBSTRINGS = [
  "apikey",
  "authorization",
  "password",
  "passwd",
  "secret",
  "credential",
  "cookie",
]

function isCredentialName(name: string): boolean {
  const words = name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const joined = words.join("")
  return (
    words.some((word) => CREDENTIAL_WORDS.has(word)) ||
    CREDENTIAL_SUBSTRINGS.some((substring) => joined.includes(substring))
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

// What a URL can carry: userinfo (`https://user:pass@host`) and the value of a credential-named
// query or fragment parameter. A key typed into the path cannot be told from a path segment, so
// the path is never touched.
function redactUrlCredentials(url: string): string {
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
 * - `baseURL` and `url` can hold userinfo or a credential-named parameter. Those are removed, and a
 *   `{{apiKey}}` placeholder stays as typed, so a DeepLX URL works again once the key is re-entered.
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
