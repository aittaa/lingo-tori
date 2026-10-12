import type { AuthTransport } from "../transport"
import type { AuthVault, VaultRecord } from "../vault"
import { vi } from "vitest"
import { base64url, ISSUER, RESOURCE, SCOPES, TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { newVaultRecord } from "../vault"
export const fetchUrl = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url
export const callbackUrl = "chrome-extension://extension/byos-callback.html"
export const sender = { id: "extension", url: callbackUrl, frameId: 0, tab: { id: 42 } }
export function memoryVault(initial?: VaultRecord): AuthVault {
  let record = structuredClone(initial ?? newVaultRecord())
  return {
    read: async () => structuredClone(record),
    update: async (change) => {
      const next = structuredClone(record)
      const result = change(next)
      record = next
      return structuredClone(result)
    },
  }
}
export function mockTransport(): AuthTransport {
  return {
    available: vi.fn<AuthTransport["available"]>(async () => true),
    createTab: vi.fn<AuthTransport["createTab"]>(async () => 42),
    install: vi.fn<AuthTransport["install"]>(async () => {}),
    navigate: vi.fn<AuthTransport["navigate"]>(async () => {}),
    cleanup: vi.fn<AuthTransport["cleanup"]>(async () => {}),
    reconcile: vi.fn<AuthTransport["reconcile"]>(async (pending) => !!pending),
  }
}
export const credentials = () => ({
  clientId: "synthetic-client",
  subject: "synthetic-subject",
  email: "person@example.test",
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  scopes: SCOPES.split(" "),
  expires: Date.now() + 3600000,
})
export async function signer() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "synthetic-key",
    use: "sig",
    alg: "RS256",
  }
  const sign = async (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = { alg: "RS256", kid: jwk.kid },
  ) => {
    const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
    const input = `${encode(header)}.${encode(claims)}`
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
  return { jwks: { keys: [jwk] }, sign }
}
export async function signedFixture(
  scopes = SCOPES,
  target = { extensionId: "extension", callbackUrl },
) {
  const vault = memoryVault(),
    transport = mockTransport(),
    keys = await signer()
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = fetchUrl(input)
    if (url === TOKEN_URL) {
      const pending = (await vault.read()).pending!
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: scopes,
        id_token: await keys.sign({
          iss: ISSUER,
          aud: "synthetic-client",
          nonce: pending.nonce,
          exp: Date.now() / 1000 + 3600,
          sub: "synthetic-subject",
          email: "person@example.test",
        }),
      })
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/synthetic-jwks` })
    if (url === `${ISSUER}/synthetic-jwks`) return Response.json(keys.jwks)
    if (url === `${RESOURCE}/models`)
      return Response.json({
        models: [{ slug: "synthetic-model", display_name: "Synthetic Model", visibility: "list" }],
      })
    throw new Error("Unmocked upstream")
  })
  const service = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    fetcher,
  )
  await service.authStart()
  const query = `?state=${(await vault.read()).pending!.state}&code=synthetic-code&client_id=synthetic-client`
  return { vault, transport, keys, fetcher, service, query }
}
