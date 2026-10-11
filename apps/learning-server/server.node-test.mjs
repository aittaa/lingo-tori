import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createState, saveNote } from "../../packages/learning-core/index.mjs"
import { LearningRepository } from "./repository.mjs"
import { createLearningServer } from "./server.mjs"
const fixtureSecret = "test-only-fixture-not-a-real-secret"
const state = saveNote(createState(), {
  id: "a",
  term: "hello",
  meaning: "안녕",
  context: "",
  language: "en",
  sourceUrl: "",
  updatedAt: 1,
})
test("SQLite persists, isolates account namespaces and rolls back invalid replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "lingotori-test-"))
  let repository
  try {
    const path = join(directory, "fixture.sqlite")
    repository = new LearningRepository(path)
    repository.sync("one", state)
    assert.equal(repository.read("two").notes.length, 0)
    repository.close()
    repository = new LearningRepository(path)
    assert.deepEqual(repository.read("one"), state)
    assert.throws(() => repository.sync("one", { ...state, schemaVersion: 2 }))
    assert.deepEqual(repository.read("one"), state)
  } finally {
    repository?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test("server refuses missing configured secret", () => {
  assert.throws(() => createLearningServer({}), /SECRET/)
})
test("loopback API requires auth, rejects hostile origins and tenant selection, replays safely", async () => {
  const server = createLearningServer({ secret: fixtureSecret })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    const headers = { Authorization: `Bearer ${fixtureSecret}`, "Content-Type": "application/json" }
    assert.equal(
      (
        await fetch(`${base}/api/state`, {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(`${base}/api/sync`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state, accountId: "other" }),
        })
      ).status,
      400,
    )
    for (let count = 0; count < 2; count++) {
      const response = await fetch(`${base}/api/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).state, state)
    }
    assert.deepEqual((await (await fetch(`${base}/api/state`, { headers })).json()).state, state)
    assert.match(await (await fetch(base)).text(), /LingoTori/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("database and sidecars use 0600 and refuse symlink or shared-directory paths", async () => {
  const { statSync, chmodSync, symlinkSync, writeFileSync, existsSync } = await import("node:fs")
  const directory = mkdtempSync(join(tmpdir(), "lingotori-private-"))
  let repository
  try {
    const path = join(directory, "private.sqlite")
    repository = new LearningRepository(path)
    repository.sync("one", state)
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(path + suffix)) assert.equal(statSync(path + suffix).mode & 0o777, 0o600)
    repository.close()
    repository = undefined
    const target = join(directory, "unrelated")
    writeFileSync(target, "keep")
    symlinkSync(target, join(directory, "linked.sqlite"))
    assert.throws(() => new LearningRepository(join(directory, "linked.sqlite")), /not links/)
    symlinkSync(target, path + "-wal")
    assert.throws(() => new LearningRepository(path), /not links/)
    chmodSync(directory, 0o777)
    assert.throws(() => new LearningRepository(join(directory, "shared.sqlite")), /not writable/)
  } finally {
    repository?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test("merged state exceeding transport limit rolls back atomically", () => {
  const repository = new LearningRepository(":memory:")
  try {
    const make = (prefix, count) => ({
      ...createState(),
      notes: Array.from({ length: count }, (_, index) => ({
        id: `${prefix}${index}`,
        term: "term",
        meaning: "x".repeat(5000),
        context: "y".repeat(10000),
        language: "en",
        sourceUrl: "",
        updatedAt: 1,
      })),
    })
    repository.sync("one", make("a", 170))
    const before = repository.read("one")
    assert.throws(() => repository.sync("one", make("b", 170)), /5 MB/)
    assert.deepEqual(repository.read("one"), before)
  } finally {
    repository.close()
  }
})
test("Host, extension CORS and exact API paths constrain bearer access", async () => {
  const server = createLearningServer({
    secret: fixtureSecret,
    allowedExtensionOrigins: ["chrome-extension://fixture"],
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: `Bearer ${fixtureSecret}` }
  try {
    const { request } = await import("node:http")
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = request(
        `${base}/api/state`,
        { headers: { ...headers, Host: "evil.example" } },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        },
      )
      req.on("error", reject)
      req.end()
    })
    assert.equal(hostileHostStatus, 403)
    assert.equal((await fetch(`${base}/api/state?token=${fixtureSecret}`, { headers })).status, 404)
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { Origin: "chrome-extension://fixture" } }))
        .status,
      401,
    )
    const allowed = await fetch(`${base}/api/state`, {
      headers: { ...headers, Origin: "chrome-extension://fixture" },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get("access-control-allow-origin"), "chrome-extension://fixture")
    assert.equal(
      (
        await fetch(`${base}/api/state`, {
          headers: { ...headers, Origin: "chrome-extension://fixture-extra" },
        })
      ).status,
      403,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
