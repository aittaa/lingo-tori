import { ByosBridgeError } from "./service"
export const ISSUER = "https://auth.openai.com"
export const RESOURCE = "https://api.openai.com/v1"
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
export const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
export const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding")
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  )
}
export async function challenge(verifier: string) {
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
}
export async function validateIdToken(
  token: string,
  jwks: unknown,
  clientId: string,
  nonce: string,
  now: number,
) {
  try {
    if (token.length > 32768) throw new Error()
    const parts = token.split(".")
    if (parts.length !== 3) throw new Error()
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]!)))
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]!)))
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined)
      throw new Error()
    const keys = (jwks as { keys?: JsonWebKey[] }).keys
    if (!Array.isArray(keys)) throw new Error()
    const selected = keys.filter(
      (key) =>
        (key as JsonWebKey & { kid?: string }).kid === header.kid &&
        key.kty === "RSA" &&
        (!key.use || key.use === "sig") &&
        (!key.alg || key.alg === "RS256"),
    )
    if (selected.length !== 1) throw new Error()
    const jwk = selected[0]!
    if (!jwk.n || decode(jwk.n).length < 256) throw new Error()
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decode(parts[2]!),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      ))
    )
      throw new Error()
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (
      claims.iss !== ISSUER ||
      !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      claims.nonce !== nonce ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) ||
      typeof claims.sub !== "string" ||
      !claims.sub
    )
      throw new Error()
    return {
      subject: claims.sub as string,
      email: typeof claims.email === "string" ? claims.email : "",
    }
  } catch {
    throw new ByosBridgeError("invalid_id_token")
  }
}
