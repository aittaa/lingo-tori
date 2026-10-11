import { z } from "zod"

export const bridgeConfigSchema = z.strictObject({
  endpoint: z.string().transform((value) => {
    const url = new URL(value)
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1024 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Use http://127.0.0.1 with the companion's configured port.")
    return url.origin
  }),
  secret: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
})
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>
export const invokeSchema = z.strictObject({
  model: z.string().min(1).max(256),
  text: z.string().min(1).max(50000),
  instructions: z.string().max(30000).optional(),
})
export type ByosInvocation = z.infer<typeof invokeSchema>
export const sessionSchema = z.object({
  state: z.enum([
    "disconnected",
    "plan-enabled",
    "identity-only",
    "restricted",
    "limit-reached",
    "reconnect-required",
    "temporarily-unavailable",
  ]),
  account: z.object({ subject: z.string(), email: z.string() }).optional(),
})
export type ByosSession = z.infer<typeof sessionSchema>
export const modelsSchema = z.object({
  models: z.array(z.object({ slug: z.string(), display_name: z.string() })),
})
export type ByosModels = z.infer<typeof modelsSchema>
export interface BridgeStore {
  read(): Promise<BridgeConfig | undefined>
  write(config: BridgeConfig | undefined): Promise<void>
}
export function assertByosSender(
  sender: { id?: string; url?: string },
  extensionId: string,
  optionsUrl?: string,
) {
  if (sender.id !== extensionId) throw new Error("Untrusted BYOS sender")
  if (optionsUrl && sender.url?.split(/[?#]/)[0] !== optionsUrl)
    throw new Error("Open BYOS in extension Settings to manage this connection")
}
export class ByosBridgeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(`BYOS: ${code}`)
  }
}
export function createByosService(
  store: BridgeStore,
  extensionOrigin: string,
  fetcher: typeof fetch = fetch,
) {
  async function request(path: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    const saved = await store.read()
    if (!saved) throw new ByosBridgeError("connection_not_configured")
    const config = bridgeConfigSchema.parse(saved)
    signal?.throwIfAborted()
    let response: Response
    try {
      response = await fetcher(`${config.endpoint}${path}`, {
        method: payload === undefined ? "GET" : "POST",
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${config.secret}`,
          "X-LingoTori-Extension-Origin": extensionOrigin,
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
          : AbortSignal.timeout(90000),
      })
    } catch {
      signal?.throwIfAborted()
      throw new ByosBridgeError("companion_unreachable")
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ByosBridgeError("invalid_companion_response")
    }
    if (!response.ok) {
      const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(body)
      const known = [
        "bridge_auth_required",
        "origin_denied",
        "plan_permission_required",
        "usage_limit",
        "limit-reached",
        "restricted",
        "busy",
        "reconnect-required",
        "inference_incomplete",
        "inference_failed",
        "invalid_stream",
      ]
      throw new ByosBridgeError(
        code.success && known.includes(code.data.error.code)
          ? code.data.error.code
          : "companion_request_failed",
        response.status,
      )
    }
    return body
  }
  return {
    async status() {
      const config = await store.read()
      return { configured: !!config, endpoint: config?.endpoint || "" }
    },
    async configure(config: unknown) {
      await store.write(config === null ? undefined : bridgeConfigSchema.parse(config))
    },
    async session() {
      return sessionSchema.parse(await request("/v1/session"))
    },
    async models() {
      return modelsSchema.parse(await request("/v1/models"))
    },
    async authStart() {
      const result = z
        .object({ authorizationUrl: z.string() })
        .parse(await request("/v1/auth/start", {}))
      const url = new URL(result.authorizationUrl)
      if (
        url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/api/accounts/authorize" ||
        url.username ||
        url.password
      )
        throw new ByosBridgeError("invalid_authorization_url")
      return result
    },
    async signout() {
      return sessionSchema
        .extend({ remoteRevocationConfirmed: z.boolean() })
        .parse(await request("/v1/signout", {}))
    },
    async invoke(payload: ByosInvocation, signal?: AbortSignal) {
      return z
        .object({ text: z.string().max(4000000) })
        .parse(await request("/v1/translate", invokeSchema.parse(payload), signal))
    },
  }
}
