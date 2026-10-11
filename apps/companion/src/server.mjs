import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Companion, CompanionError } from "./core.mjs"
import { CredentialStore } from "./store.mjs"
function equal(a, b) {
  const x = Buffer.from(a),
    y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
export function createCompanionServer({ companion, origins, bridgeSecret, port }) {
  if (
    !Array.isArray(origins) ||
    !origins.length ||
    origins.some(
      (origin) => !/^(chrome-extension|moz-extension):\/\/[a-zA-Z0-9-]+$/.test(origin),
    ) ||
    typeof bridgeSecret !== "string" ||
    bridgeSecret.length < 32
  )
    throw new CompanionError("invalid_bridge_configuration")
  let busy = false
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("X-Content-Type-Options", "nosniff")
    const json = (status, value) => {
      if (res.destroyed) return
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(value))
    }
    try {
      const expectedHost = `127.0.0.1:${port || server.address().port}`
      if (
        req.headers.host !== expectedHost ||
        !req.url.startsWith("/") ||
        req.url.startsWith("//") ||
        req.url.includes("\\")
      )
        throw new CompanionError("invalid_host", 403)
      const url = new URL(req.url, `http://${expectedHost}`)
      if (url.pathname === "/auth/callback" && req.method === "GET") {
        if (busy) throw new CompanionError("busy", 409)
        if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length > 1))
          throw new CompanionError("invalid_callback")
        busy = true
        try {
          await companion.callback(url.searchParams)
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Security-Policy": "default-src 'none'",
            "Referrer-Policy": "no-referrer",
          })
          res.end("ChatGPT connection completed. Return to LingoTori.")
        } finally {
          busy = false
        }
        return
      }
      const browserOrigin = req.headers.origin
      const declaredOrigin = req.headers["x-lingotori-extension-origin"]
      // Privileged background fetch may omit Origin. Its explicit identity header
      // is only a routing claim: the pairing bearer remains mandatory below.
      const origin = browserOrigin ?? declaredOrigin
      if (
        !origins.includes(origin) ||
        (declaredOrigin !== undefined && declaredOrigin !== origin) ||
        (req.method === "OPTIONS" && browserOrigin === undefined)
      )
        throw new CompanionError("origin_denied", 403)
      if (browserOrigin !== undefined) res.setHeader("Access-Control-Allow-Origin", browserOrigin)
      res.setHeader("Vary", "Origin")
      if (req.method === "OPTIONS") {
        if (
          !["GET", "POST"].includes(req.headers["access-control-request-method"]) ||
          String(req.headers["access-control-request-headers"] || "")
            .split(",")
            .some(
              (h) =>
                !["authorization", "content-type", "x-lingotori-extension-origin"].includes(
                  h.trim().toLowerCase(),
                ),
            )
        )
          throw new CompanionError("preflight_denied", 403)
        res.setHeader("Access-Control-Allow-Methods", "GET, POST")
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-LingoTori-Extension-Origin",
        )
        res.writeHead(204)
        res.end()
        return
      }
      if (!equal(req.headers.authorization || "", `Bearer ${bridgeSecret}`))
        throw new CompanionError("bridge_auth_required", 401)
      if (url.search) throw new CompanionError("query_not_allowed")
      if (req.method === "GET" && url.pathname === "/v1/session")
        return json(200, companion.session())
      if (busy) throw new CompanionError("busy", 409)
      busy = true
      try {
        if (req.method === "GET" && url.pathname === "/v1/models")
          return json(200, await companion.models())
        if (
          req.method !== "POST" ||
          !["/v1/auth/start", "/v1/signout", "/v1/translate"].includes(url.pathname)
        )
          throw new CompanionError("not_found", 404)
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          throw new CompanionError("json_required", 415)
        const chunks = []
        let bodyBytes = 0
        for await (const chunk of req) {
          bodyBytes += chunk.length
          if (bodyBytes > 500000) throw new CompanionError("body_too_large", 413)
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks).toString("utf8")
        let data
        try {
          data = JSON.parse(body)
        } catch {
          throw new CompanionError("invalid_json")
        }
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new CompanionError("invalid_json")
        const allowed = url.pathname === "/v1/translate" ? ["text", "model", "instructions"] : []
        if (Object.keys(data).some((k) => !allowed.includes(k)))
          throw new CompanionError("unsupported_field")
        if (url.pathname === "/v1/auth/start") return json(200, await companion.startAuth())
        if (url.pathname === "/v1/signout") return json(200, await companion.signout())
        const controller = new AbortController()
        const abort = () => {
          if (!res.writableEnded) controller.abort()
        }
        res.once("close", abort)
        try {
          return json(200, await companion.translate(data, controller.signal))
        } finally {
          res.off("close", abort)
        }
      } finally {
        busy = false
      }
    } catch (error) {
      json(
        error instanceof CompanionError && error.status >= 400 && error.status <= 599
          ? error.status
          : 500,
        { error: { code: error instanceof CompanionError ? error.code : "companion_failure" } },
      )
    }
  })
  server.requestTimeout = 90000
  server.headersTimeout = 10000
  server.maxHeadersCount = 32
  return server
}
export async function main(env = process.env) {
  if (env.LINGOTORI_COMPANION_ENABLE !== "1") throw new CompanionError("explicit_start_required")
  const directory = env.LINGOTORI_COMPANION_CONFIG_DIR
  const port = Number(env.LINGOTORI_COMPANION_PORT)
  const origins = (env.LINGOTORI_EXTENSION_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
  if (
    !directory ||
    resolve(directory) !== directory ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new CompanionError("explicit_configuration_required")
  const store = new CredentialStore(directory),
    bridgeStore = new CredentialStore(directory, "bridge.json")
  const unlock = await store.lock()
  try {
    let bridge = await bridgeStore.read()
    if (!bridge) {
      bridge = { secret: randomBytes(32).toString("base64url") }
      await bridgeStore.write(bridge)
    }
    const companion = new Companion({
      store,
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
    })
    await companion.initialize()
    const server = createCompanionServer({ companion, origins, bridgeSecret: bridge.secret, port })
    await new Promise((done, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", done)
    })
    const close = () =>
      server.close(() => {
        unlock().then(
          () => process.exit(0),
          () => process.exit(1),
        )
      })
    process.once("SIGINT", close)
    process.once("SIGTERM", close)
    console.log(
      `LingoTori companion listening on 127.0.0.1:${port}. Pair using the protected bridge.json file in your configured directory.`,
    )
    return server
  } catch (error) {
    await unlock()
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof CompanionError ? error.code : "companion_start_failed")
    process.exitCode = 1
  })
