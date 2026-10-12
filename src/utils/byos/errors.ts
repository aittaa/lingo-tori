export interface ByosFailureDetails {
  code: string
  status: number
  param?: string
  requestId?: string
}
export const TERMINAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
])
const upstreamCodes = new Set([
  ...TERMINAL_REFRESH_CODES,
  "invalid_client",
  "invalid_token",
  "invalid_api_key",
  "invalid_request_error",
  "rate_limit_exceeded",
  "insufficient_quota",
  "model_not_found",
  "permission_denied",
  "unsupported_value",
  "context_length_exceeded",
  "server_error",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
  "subscription_sharing_user_unavailable",
])
const parameterRoots =
  "input|tools|model|service_tier|instructions|response_format|temperature|max_output_tokens|stream|store|resource|client_id|grant_type|scope|token|token_type_hint|code|redirect_uri|code_verifier"
const paramPattern = new RegExp(
  `^(?:${parameterRoots})(?:\\.[A-Za-z_][A-Za-z0-9_]{0,31}|\\[\\d{1,6}\\]){0,8}$`,
)
const safeParam = (value: unknown) =>
  typeof value === "string" && value.length <= 128 && paramPattern.test(value) ? value : undefined
const safeRequestId = (value: unknown) =>
  typeof value === "string" &&
  /^(?:req[_-][A-Za-z0-9_-]{1,120}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(
    value,
  )
    ? value
    : undefined
export class ByosBridgeError extends Error implements ByosFailureDetails {
  readonly code: string
  readonly status: number
  readonly param?: string
  readonly requestId?: string
  constructor(code: string, status = 0, details: { param?: unknown; requestId?: unknown } = {}) {
    const safeCode = /^[a-z][a-z0-9_-]{0,95}$/.test(code) ? code : "upstream_failure"
    super(`BYOS: ${safeCode}`)
    this.name = "ByosBridgeError"
    this.code = safeCode
    this.status = Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0
    this.param = safeParam(details.param)
    this.requestId = safeRequestId(details.requestId)
  }
}
export function machineError(body: unknown, status: number, requestId?: string | null) {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const error = record.error
  const fields = error && typeof error === "object" ? (error as Record<string, unknown>) : record
  const code = typeof error === "string" ? error : fields.code
  const fallback =
    status === 429
      ? "usage_limit"
      : status === 403
        ? "restricted"
        : status === 401
          ? "authorization_required"
          : "upstream_failure"
  // Unknown diagnostics may contain credentials. Only known machine codes and
  // parameter paths leave this parser; arbitrary message/detail fields never do.
  return new ByosBridgeError(
    typeof code === "string" && upstreamCodes.has(code) ? code : fallback,
    status,
    { param: fields.param, requestId: requestId ?? record.request_id ?? fields.request_id },
  )
}
export function failureDetails(error: ByosBridgeError): ByosFailureDetails {
  return {
    code: error.code,
    status: error.status,
    ...(error.param ? { param: error.param } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
  }
}
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
export async function responseError(response: Response, signal?: AbortSignal) {
  let body: unknown
  const readSignal = signal ?? AbortSignal.timeout(5000)
  const reader = response.body?.getReader()
  if (reader) {
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await abortable(reader.read(), readSignal)
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 16384) break
        chunks.push(chunk.value)
      }
      if (bytes <= 16384) {
        const merged = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }
        body = JSON.parse(new TextDecoder().decode(merged))
      }
    } catch {
      /* Error bodies are optional diagnostic input, never retained. */
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  return machineError(body, response.status, response.headers.get("x-request-id"))
}
