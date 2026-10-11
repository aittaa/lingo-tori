import assert from "node:assert/strict"
import { mkdtemp, realpath, mkdir, chmod, link, symlink, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Companion, RESOURCE, SCOPES, TOKEN_URL } from "../src/core.mjs"
import { createCompanionServer } from "../src/server.mjs"
import { CredentialStore } from "../src/store.mjs"

const now = 1800000000000
const tokenResponse = {
  access_token: "review-new-access",
  refresh_token: "review-new-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: SCOPES,
}
function make(
  fetcher = async () => {
    throw new Error("unmocked network prohibited")
  },
) {
  const record = {
    access_token: "review-old-access",
    refresh_token: "review-old-refresh",
    hostId: "review-host",
    client_id: "review-client",
    subject: "review-subject",
    scopes: SCOPES.split(" "),
    expires_at: now + 3600000,
  }
  const store = {
    value: record,
    async read() {
      return structuredClone(this.value)
    },
    async write(next) {
      this.value = structuredClone(next)
    },
  }
  const companion = new Companion({
    store,
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    now: () => now,
    fetcher,
  })
  return { companion, store }
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
function stream(events) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  })
}

test("401 performs exactly one forced refresh and retries with rotated token", async () => {
  const calls = []
  const { companion } = make(async (url, options) => {
    calls.push(url)
    if (url === TOKEN_URL) return json(tokenResponse)
    assert.equal(url, `${RESOURCE}/models`)
    if (calls.length === 1) return json({ detail: "expired" }, 401)
    assert.equal(options.headers.Authorization, "Bearer review-new-access")
    return json({ models: [{ slug: "review-model", display_name: "Review", visibility: "list" }] })
  })
  await companion.initialize()
  assert.equal((await companion.models()).models[0].slug, "review-model")
  assert.deepEqual(calls, [`${RESOURCE}/models`, TOKEN_URL, `${RESOURCE}/models`])
})

test("repeated inference 401 is bounded and requires reconnection", async () => {
  let refreshes = 0,
    requests = 0
  const { companion } = make(async (url) => {
    if (url === TOKEN_URL) {
      refreshes++
      return json(tokenResponse)
    }
    requests++
    return json({}, 401)
  })
  await companion.initialize()
  await assert.rejects(companion.translate({ model: "review", text: "hello" }))
  assert.equal(refreshes, 1)
  assert.equal(requests, 2)
  assert.equal(companion.session().state, "reconnect-required")
})

test("SSE rejects non-string deltas and post-completion output", async () => {
  for (const events of [
    [
      { type: "response.output_text.delta", delta: { secret: "not text" } },
      { type: "response.completed", response: { status: "completed" } },
    ],
    [
      { type: "response.completed", response: { status: "completed" } },
      { type: "response.output_text.delta", delta: "late" },
    ],
  ]) {
    const { companion } = make(async () => stream(events))
    await companion.initialize()
    await assert.rejects(companion.translate({ model: "review", text: "hello" }), /invalid_stream/)
  }
})

test("signout makes memory credentials unavailable even when persistence fails", async () => {
  const { companion, store } = make()
  await companion.initialize()
  store.write = async () => {
    throw new Error("disk unavailable")
  }
  await assert.rejects(companion.signout())
  assert.equal(companion.record.access_token, undefined)
  assert.equal(companion.record.refresh_token, undefined)
  assert.equal(companion.record.id_token, undefined)
  await assert.rejects(companion.accessToken(), /plan_permission_required/)
})

test("bridge handles privileged extension origin header without accepting webpage spoofing", async () => {
  const { companion } = make()
  await companion.initialize()
  const origin = "chrome-extension://reviewextension"
  const secret = "review-bridge-secret-000000000000000000"
  const server = createCompanionServer({
    companion,
    origins: [origin],
    bridgeSecret: secret,
    port: 0,
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const host = `127.0.0.1:${server.address().port}`
  const request = (path, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path,
          method,
          headers: { Host: host, Authorization: `Bearer ${secret}`, ...headers },
        },
        (res) => {
          let body = ""
          res.on("data", (data) => (body += data))
          res.on("end", () => resolve({ status: res.statusCode, body }))
        },
      )
      req.on("error", reject)
      req.end()
    })
  try {
    assert.equal(
      (await request("/v1/session", { "X-LingoTori-Extension-Origin": origin })).status,
      200,
    )
    assert.equal(
      (
        await request("/v1/session", {
          "X-LingoTori-Extension-Origin": origin,
          Origin: "https://attacker.example",
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request("/v1/session", {
          "X-LingoTori-Extension-Origin": "chrome-extension://other",
          Origin: origin,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request("/v1/session", {
          "X-LingoTori-Extension-Origin": origin,
          Authorization: "Bearer wrong",
        })
      ).status,
      401,
    )
    assert.equal(
      (
        await request(
          "/v1/session",
          { "X-LingoTori-Extension-Origin": origin, "Access-Control-Request-Method": "GET" },
          "OPTIONS",
        )
      ).status,
      403,
    )
    assert.equal((await request("//attacker.example/v1/session", { Origin: origin })).status, 403)
    const response = await request("/v1/session", { Origin: origin })
    assert(!response.body.includes("review-old-access"))
    assert(!response.body.includes("review-old-refresh"))
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("consumed OAuth callback cannot be replayed after denial", async () => {
  const { companion } = make()
  await companion.initialize()
  const authorization = new URL((await companion.startAuth()).authorizationUrl)
  const params = new URLSearchParams({
    state: authorization.searchParams.get("state"),
    error: "access_denied",
  })
  await assert.rejects(companion.callback(params), /consent_denied/)
  await assert.rejects(companion.callback(params), /invalid_oauth_state/)
})

test("401 scope downgrade stops before retrying subscription inference", async () => {
  let calls = 0
  const { companion } = make(async (url) => {
    calls++
    return url === TOKEN_URL ? json({ ...tokenResponse, scope: "openid" }) : json({}, 401)
  })
  await companion.initialize()
  await assert.rejects(
    companion.translate({ model: "review", text: "hello" }),
    /plan_permission_required/,
  )
  assert.equal(calls, 2)
  assert.equal(companion.session().state, "identity-only")
})

test("upstream error bodies cannot escape through public errors", async () => {
  const { companion } = make(async () =>
    json(
      { detail: "review-secret-token-do-not-expose", error: { message: "review-refresh-secret" } },
      503,
    ),
  )
  await companion.initialize()
  await assert.rejects(companion.models(), (error) => {
    assert.equal(error.code, "upstream_failure")
    assert(!String(error).includes("review-secret"))
    assert(!JSON.stringify(error).includes("review-refresh"))
    return true
  })
})

test("credential store rejects hard links, symlink parents, unsafe directory modes and traversal", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "lingotori-review-")))
  try {
    assert.throws(() => new CredentialStore(temp, "../outside"), /invalid_store_path/)
    const directory = join(temp, "private")
    const store = new CredentialStore(directory)
    await store.write({ token: "synthetic-review-token" })
    await link(store.path, join(temp, "hardlink"))
    await assert.rejects(store.read(), /credential_store_failure/)
    await assert.rejects(store.write({ token: "replacement" }), /unsafe_credential_file/)
    await rm(join(temp, "hardlink"))
    await symlink(directory, join(temp, "linked"))
    await assert.rejects(new CredentialStore(join(temp, "linked")).read(), /unsafe_store_directory/)
    const unsafe = join(temp, "unsafe")
    await mkdir(unsafe, { mode: 0o700 })
    await chmod(unsafe, 0o755)
    await assert.rejects(new CredentialStore(unsafe).write({}), /unsafe_store_directory/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
