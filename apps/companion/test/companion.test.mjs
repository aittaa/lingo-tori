import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, chmod, lstat, symlink, rm, realpath, readFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Companion, validateIdToken, ISSUER, SCOPES, RESOURCE } from "../src/core.mjs"
import { createCompanionServer, main } from "../src/server.mjs"
import { CredentialStore } from "../src/store.mjs"
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }] }
const now = 1800000000000
function jwt(changes = {}, headerChanges = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "fixture", ...headerChanges }),
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: "issued-fixture",
      sub: "synthetic-subject",
      nonce: "fixture-nonce",
      exp: now / 1000 + 3600,
      ...changes,
    }),
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`
}
const tokens = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: SCOPES,
}
const record = () => ({
  ...tokens,
  hostId: "urn:uuid:fixture",
  client_id: "issued-fixture",
  subject: "synthetic-subject",
  scopes: SCOPES.split(" "),
  expires_at: now + 3600000,
})
function memory(value = null) {
  return {
    value,
    async read() {
      return structuredClone(this.value)
    },
    async write(v) {
      this.value = structuredClone(v)
    },
  }
}
async function make({
  value = record(),
  fetcher = async () => {
    throw new Error("unmocked network")
  },
} = {}) {
  const store = memory(value)
  const companion = new Companion({
    store,
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    now: () => now,
    random: () => "fixture-nonce",
    fetcher,
  })
  await companion.initialize()
  return { companion, store }
}
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
test("JWT verifies signature and rejects each identity/algorithm boundary", () => {
  const options = { clientId: "issued-fixture", nonce: "fixture-nonce", now: now / 1000 }
  assert.equal(validateIdToken(jwt(), jwks, options).sub, "synthetic-subject")
  for (const changes of [
    { iss: "https://evil.example" },
    { aud: "other" },
    { nonce: "other" },
    { exp: 0 },
    { sub: "" },
    { aud: ["issued-fixture", "other"] },
    { nbf: now / 1000 + 50 },
  ])
    assert.throws(() => validateIdToken(jwt(changes), jwks, options), /invalid_id_token/)
  assert.throws(() => validateIdToken(jwt({}, { alg: "none" }), jwks, options), /invalid_id_token/)
  const signed = jwt().split(".")
  signed[2] = Buffer.alloc(256).toString("base64url")
  assert.throws(() => validateIdToken(signed.join("."), jwks, options))
})
test("auth creates PKCE URL but makes no network calls; rejects callback state", async () => {
  const { companion } = await make({ value: null })
  const url = new URL((await companion.startAuth()).authorizationUrl)
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client")
  assert.equal(url.searchParams.get("agent_name_hint"), "LingoTori")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("scope"), SCOPES)
  await assert.rejects(
    companion.callback(new URLSearchParams({ state: "wrong", code: "fake" })),
    /invalid_oauth_state/,
  )
  await assert.rejects(
    companion.callback(new URLSearchParams({ state: "fixture-nonce", error: "access_denied" })),
    /consent_denied/,
  )
})
test("mock callback verifies issued ID, persists scope and token set", async () => {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push([url, options])
    if (url.endsWith("/oauth/token")) return json({ ...tokens, id_token: jwt() })
    if (url.endsWith("openid-configuration"))
      return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` })
    if (url.endsWith("/jwks")) return json(jwks)
    throw new Error("unexpected mock URL")
  }
  const { companion, store } = await make({ value: null, fetcher })
  await companion.startAuth()
  const result = await companion.callback(
    new URLSearchParams({
      state: "fixture-nonce",
      client_id: "issued-fixture",
      code: "fixture-code",
    }),
  )
  assert.equal(result.state, "plan-enabled")
  assert.equal(store.value.client_id, "issued-fixture")
  assert.equal(calls[0][1].body.get("client_id"), "issued-fixture")
  assert.equal(calls[0][1].redirect, "error")
  assert(!JSON.stringify(result).includes("synthetic-access"))
})
test("reauthorization rejects changed client before exchange", async () => {
  const { companion } = await make()
  await companion.startAuth()
  await assert.rejects(
    companion.callback(
      new URLSearchParams({ state: "fixture-nonce", client_id: "other", code: "fixture-code" }),
    ),
    /invalid_oauth_callback/,
  )
})
test("missing plan scope prevents any inference request", async () => {
  const { companion } = await make({ value: { ...record(), scopes: ["openid"] } })
  assert.equal(companion.session().state, "identity-only")
  await assert.rejects(companion.models(), /plan_permission_required/)
})
test("concurrent refresh coalesces and replaces rotating credentials", async () => {
  let calls = 0
  const { companion, store } = await make({
    value: { ...record(), expires_at: now },
    fetcher: async (url, options) => {
      calls++
      assert.equal(options.body.get("grant_type"), "refresh_token")
      await new Promise((resolve) => setImmediate(resolve))
      return json({ ...tokens, refresh_token: "synthetic-rotated" })
    },
  })
  await Promise.all([companion.accessToken(), companion.accessToken()])
  assert.equal(calls, 1)
  assert.equal(store.value.refresh_token, "synthetic-rotated")
})
test("terminal refresh clears credentials; transient failure preserves them", async () => {
  for (const [status, body, cleared] of [
    [400, { error: "invalid_grant" }, true],
    [503, { detail: "synthetic failure" }, false],
  ]) {
    const { companion, store } = await make({
      value: { ...record(), expires_at: now },
      fetcher: async () => new Response(JSON.stringify(body), { status }),
    })
    await assert.rejects(companion.accessToken())
    assert.equal(!store.value.access_token, cleared)
  }
})
test("models filter visibility and preserve account ordering", async () => {
  const { companion } = await make({
    fetcher: async (url) => {
      assert.equal(url, `${RESOURCE}/models`)
      return json({
        models: [
          { slug: "a", display_name: "A", visibility: "list" },
          { slug: "hidden", visibility: "hide" },
          { slug: "b", display_name: "B", visibility: "list" },
        ],
      })
    },
  })
  assert.deepEqual(await companion.models(), {
    models: [
      { slug: "a", display_name: "A" },
      { slug: "b", display_name: "B" },
    ],
  })
})
function stream(events) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
test("fragmented SSE requires completed response and uses public allowlisted request", async () => {
  const { companion } = await make({
    fetcher: async (url, options) => {
      assert.equal(url, `${RESOURCE}/responses`)
      const body = JSON.parse(options.body)
      assert.deepEqual(Object.keys(body), ["model", "instructions", "input", "store", "stream"])
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      return stream([
        { type: "response.output_text.delta", delta: "번역" },
        { type: "response.completed", response: { status: "completed" } },
      ])
    },
  })
  assert.deepEqual(await companion.translate({ text: "source", model: "fixture-model" }), {
    text: "번역",
  })
  await assert.rejects(
    companion.request("https://chatgpt.com/backend-api/responses"),
    /invalid_upstream/,
  )
})
test("incomplete and failed streams never return partial success", async () => {
  for (const ending of [
    null,
    { type: "response.failed" },
    { type: "response.completed", response: { status: "incomplete" } },
  ]) {
    const events = [
      { type: "response.output_text.delta", delta: "partial" },
      ...(ending ? [ending] : []),
    ]
    const { companion } = await make({ fetcher: async () => stream(events) })
    await assert.rejects(companion.translate({ text: "source", model: "fixture" }))
  }
})
test("limits stop further work without billing fallback", async () => {
  let calls = 0
  const { companion } = await make({
    fetcher: async () => {
      calls++
      return new Response("{}", { status: 429 })
    },
  })
  await assert.rejects(companion.translate({ text: "source", model: "fixture" }), /usage_limit/)
  await assert.rejects(companion.translate({ text: "source", model: "fixture" }), /limit-reached/)
  assert.equal(calls, 1)
})
test("unconfirmed remote revocation still clears local tokens", async () => {
  const { companion, store } = await make()
  const result = await companion.signout()
  assert.equal(result.remoteRevocationConfirmed, false)
  assert.equal(result.state, "disconnected")
  assert.equal(store.value.access_token, undefined)
  assert.equal(store.value.client_id, "issued-fixture")
})
test("protected file modes, atomic replacement, symlink rejection and runtime lock", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "lingotori-fixture-")))
  const directory = join(temp, "private")
  try {
    const store = new CredentialStore(directory)
    await store.write({ token: "fixture-one" })
    await store.write({ token: "fixture-two" })
    assert.equal((await lstat(store.path)).mode & 0o777, 0o600)
    assert.deepEqual(await store.read(), { token: "fixture-two" })
    const unlock = await store.lock()
    await assert.rejects(store.lock(), /runtime_already_locked/)
    await unlock()
    await chmod(store.path, 0o644)
    await assert.rejects(store.read())
    await chmod(store.path, 0o600)
    await rm(store.path)
    await symlink(join(temp, "outside"), store.path)
    await assert.rejects(store.write({ token: "fixture" }))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
test("HTTP bridge rejects webpage origins, missing secret, hostile Host and unknown fields", async () => {
  const { companion } = await make()
  const origin = "chrome-extension://testextension"
  const secret = "fixture-bridge-secret-000000000000000"
  const server = createCompanionServer({
    companion,
    origins: [origin],
    bridgeSecret: secret,
    port: 0,
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(
      (
        await fetch(`${base}/v1/session`, {
          headers: { Origin: "https://evil.example", Authorization: `Bearer ${secret}` },
        })
      ).status,
      403,
    )
    assert.equal((await fetch(`${base}/v1/session`, { headers: { Origin: origin } })).status, 401)
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}/v1/session`,
        { headers: { Origin: origin, Authorization: `Bearer ${secret}`, Host: "evil.example" } },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        },
      )
      req.on("error", reject)
      req.end()
    })
    assert.equal(hostileHostStatus, 403)
    const result = await fetch(`${base}/v1/session`, {
      headers: { Origin: origin, Authorization: `Bearer ${secret}` },
    })
    assert.equal(result.status, 200)
    assert.equal((await result.json()).state, "plan-enabled")
    const post = await fetch(`${base}/v1/translate`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "x", model: "x", url: "https://evil.example" }),
    })
    assert.equal(post.status, 400)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
test("runtime requires explicit opt-in and never starts by import", async () => {
  await assert.rejects(main({}), /explicit_start_required/)
})
test("scope downgrade on refresh prevents subsequent inference", async () => {
  let calls = 0
  const { companion } = await make({
    value: { ...record(), expires_at: now },
    fetcher: async () => {
      calls++
      return json({ ...tokens, scope: "openid" })
    },
  })
  await assert.rejects(companion.models(), /plan_permission_required/)
  assert.equal(calls, 1)
  assert.equal(companion.session().state, "identity-only")
})
test("expired callback and identity substitution cannot overwrite stored credentials", async () => {
  const { companion, store } = await make({
    fetcher: async (url) =>
      url.endsWith("/oauth/token")
        ? json({ ...tokens, id_token: jwt({ sub: "another-subject" }) })
        : url.endsWith("openid-configuration")
          ? json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` })
          : json(jwks),
  })
  await companion.startAuth()
  companion.pending.expires = now - 1
  await assert.rejects(
    companion.callback(new URLSearchParams({ state: "fixture-nonce", code: "fixture" })),
    /invalid_oauth_state/,
  )
  await companion.startAuth()
  await assert.rejects(
    companion.callback(new URLSearchParams({ state: "fixture-nonce", code: "fixture" })),
    /account_mismatch/,
  )
  assert.equal(store.value.subject, "synthetic-subject")
})
test("new issued client survives failed code exchange without using bootstrap client again", async () => {
  const { companion, store } = await make({
    value: null,
    fetcher: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  })
  await companion.startAuth()
  await assert.rejects(
    companion.callback(
      new URLSearchParams({ state: "fixture-nonce", client_id: "issued-fixture", code: "fixture" }),
    ),
  )
  assert.equal(store.value.client_id, "issued-fixture")
  assert.equal(
    new URL((await companion.startAuth()).authorizationUrl).searchParams.get("client_id"),
    "issued-fixture",
  )
})
test("successful signout posts refresh token only to trusted discovered endpoint", async () => {
  let revoked = false
  const { companion } = await make({
    fetcher: async (url, options) => {
      if (url.endsWith("openid-configuration"))
        return json({ issuer: ISSUER, revocation_endpoint: `${ISSUER}/revoke` })
      assert.equal(url, `${ISSUER}/revoke`)
      assert.equal(options.body.get("token"), "synthetic-refresh")
      revoked = true
      return new Response(null, { status: 200 })
    },
  })
  assert.equal((await companion.signout()).remoteRevocationConfirmed, true)
  assert(revoked)
})

test("actual built-in dictionary prompt passes through Companion with bounded instructions", async () => {
  const localeSource = await readFile(
    new URL("../../../src/locales/en.yml", import.meta.url),
    "utf8",
  )
  const template = localeSource
    .split("      templates:")[1]
    ?.split("          systemPrompt: |-\n")[1]
    ?.split("          prompt: |-")[0]
  assert.ok(template)
  const instructions = template.replace(/^            /gm, "")
  assert.ok(instructions.length > 4000)
  assert.ok(instructions.length <= 30000)
  let calls = 0
  const { companion } = await make({
    fetcher: async (url, options) => {
      calls++
      assert.equal(url, `${RESOURCE}/responses`)
      assert.equal(
        JSON.parse(options.body).instructions,
        calls === 1 ? instructions : "x".repeat(30000),
      )
      return stream([
        { type: "response.output_text.delta", delta: '{"Definition":"A flower"}' },
        { type: "response.completed", response: { status: "completed" } },
      ])
    },
  })
  assert.deepEqual(await companion.translate({ model: "fixture", text: "blossom", instructions }), {
    text: '{"Definition":"A flower"}',
  })
  await companion.translate({ model: "fixture", text: "blossom", instructions: "x".repeat(30000) })
  await assert.rejects(
    companion.translate({ model: "fixture", text: "blossom", instructions: "x".repeat(30001) }),
    /invalid_request/,
  )
  assert.equal(calls, 2)
})

test("caller cancellation reaches real companion upstream and prevents success", async () => {
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  let upstreamSignal
  const { companion } = await make({
    fetcher: async (_url, options) => {
      upstreamSignal = options.signal
      started()
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      )
    },
  })
  const controller = new AbortController()
  const job = companion.translate({ model: "fixture", text: "source" }, controller.signal)
  await ready
  controller.abort()
  await assert.rejects(job, { name: "AbortError" })
  assert.equal(upstreamSignal.aborted, true)
})
test("bridge disconnect cancels translation and releases busy slot", async () => {
  let started, aborted
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const stopped = new Promise((resolve) => {
    aborted = resolve
  })
  const origin = "chrome-extension://testextension"
  const secret = "fixture-bridge-secret-000000000000000"
  const companion = {
    async translate(_data, signal) {
      started()
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted()
            reject(signal.reason)
          },
          { once: true },
        ),
      )
    },
    async models() {
      return { models: [] }
    },
  }
  const server = createCompanionServer({
    companion,
    origins: [origin],
    bridgeSecret: secret,
    port: 0,
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = {
    Origin: origin,
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  }
  try {
    const req = httpRequest(`${base}/v1/translate`, { method: "POST", headers })
    req.on("error", () => {})
    req.end(JSON.stringify({ model: "fixture", text: "source" }))
    await ready
    req.destroy()
    await stopped
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await fetch(`${base}/v1/models`, { headers })).status, 200)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("HTTP JSON limit admits full escaped text/instructions contract and rejects excess bytes", async () => {
  const { companion } = await make({
    fetcher: async () =>
      stream([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed" } },
      ]),
  })
  const origin = "chrome-extension://testextension"
  const secret = "fixture-bridge-secret-000000000000000"
  const server = createCompanionServer({
    companion,
    origins: [origin],
    bridgeSecret: secret,
    port: 0,
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1/translate`
  const headers = {
    Origin: origin,
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  }
  try {
    const body = JSON.stringify({
      model: "fixture",
      text: "\0".repeat(50000),
      instructions: "\0".repeat(30000),
    })
    assert.ok(Buffer.byteLength(body) > 250000)
    const accepted = await fetch(url, { method: "POST", headers, body })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { text: "ok" })
    const excess = await fetch(url, { method: "POST", headers, body: " ".repeat(500001) })
    assert.equal(excess.status, 413)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
