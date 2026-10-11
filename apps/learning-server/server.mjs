import { timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { LearningRepository } from "./repository.mjs"
const assets = new Map([
  ["/", ["text/html; charset=utf-8", new URL("./public/index.html", import.meta.url)]],
  ["/app.mjs", ["text/javascript; charset=utf-8", new URL("./public/app.mjs", import.meta.url)]],
  ["/style.css", ["text/css; charset=utf-8", new URL("./public/style.css", import.meta.url)]],
  [
    "/core.mjs",
    [
      "text/javascript; charset=utf-8",
      new URL("../../packages/learning-core/index.mjs", import.meta.url),
    ],
  ],
])
export function createLearningServer({
  secret,
  databasePath = ":memory:",
  accountId = "local",
  allowedExtensionOrigins = [],
}) {
  if (typeof secret !== "string" || secret.length < 24 || secret.length > 1024)
    throw new Error("Configure LINGOTORI_SYNC_SECRET with 24–1024 characters")
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) throw new Error("Invalid server account ID")
  if (
    allowedExtensionOrigins.some(
      (value) => !/^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(value),
    )
  )
    throw new Error("Only exact extension origins are allowed")
  const repository = new LearningRepository(databasePath)
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    response.setHeader("Referrer-Policy", "no-referrer")
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(value))
    }
    const expectedHost = `127.0.0.1:${server.address()?.port}`
    if (request.headers.host !== expectedHost) return send(403, { error: "Invalid host" })
    const origin = request.headers.origin
    const ownOrigin = `http://${expectedHost}`
    if (origin && origin !== ownOrigin && !allowedExtensionOrigins.includes(origin))
      return send(403, { error: "Origin not allowed" })
    if (origin && allowedExtensionOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin)
      response.setHeader("Vary", "Origin")
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      return response.end()
    }
    const path = request.url
    if (request.method === "GET" && assets.has(path)) {
      const [type, file] = assets.get(path)
      response.writeHead(200, { "Content-Type": type })
      return response.end(readFileSync(file))
    }
    const actual = Buffer.from(request.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${secret}`)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return send(401, { error: "Authentication required" })
    if (path === "/api/state" && request.method === "GET") {
      try {
        return send(200, { state: repository.read(accountId) })
      } catch {
        return send(500, { error: "Learning storage unavailable" })
      }
    }
    if (path !== "/api/sync" || request.method !== "POST") return send(404, { error: "Not found" })
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return send(415, { error: "JSON required" })
    try {
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > 5_000_000) {
          return send(413, { error: "Payload too large" })
        }
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || Object.keys(body).length !== 1 || !body.state) throw new Error("Expected state")
      return send(200, { state: repository.sync(accountId, body.state) })
    } catch {
      return send(400, { error: "Invalid learning state or conflicting event ID" })
    }
  })
  server.on("close", () => repository.close())
  return server
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LINGOTORI_PORT || 4317)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port")
  const server = createLearningServer({
    secret: process.env.LINGOTORI_SYNC_SECRET,
    databasePath: process.env.LINGOTORI_DB_PATH || "./lingotori-learning.sqlite",
    accountId: process.env.LINGOTORI_ACCOUNT_ID || "local",
    allowedExtensionOrigins: (process.env.LINGOTORI_EXTENSION_ORIGINS || "")
      .split(",")
      .filter(Boolean),
  })
  server.listen(port, "127.0.0.1", () =>
    console.log(`LingoTori learning: http://127.0.0.1:${port}`),
  )
}
