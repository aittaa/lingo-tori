import type { OperationRequest } from "../commit-protocol"
import type { Config } from "@/types/config/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  attachConfigCommitMessages,
  createConfigCommitService,
} from "@/entrypoints/background/config-commit-service"
import { configSchema } from "@/types/config/config"
import { COMMIT_MESSAGE_TYPE, operationDigest } from "../commit-protocol"
import { fingerprintOf, getConfigStatus } from "../status"
import { commitClient, editConfig, replaceConfig } from "../write-guard"
import {
  backupEntries,
  committedMeta,
  corruptConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  seedPrimary,
  snapshot,
  validConfig,
} from "./preservation-test-kit"

// Everything here goes through the real `@webext-core/messaging` path over the fake browser: the
// writer sends its request with `runtime.sendMessage`, a listener registered with `onMessage` (the
// shared test setup attaches the background's service) answers it. A browser serializes a message
// on the way: Chrome as JSON (an `undefined` property disappears), Firefox as structured clone (it
// stays). The fake browser does neither, so the tests do it themselves, in both shapes, and also
// run without it as a control.
type Wire = "json" | "structured-clone" | "none"
type Decision = "deliver" | "drop-answer" | "lose" | "hang"
interface Sent {
  kind?: string
  attempt?: string
  opId?: string
}
interface Envelope {
  type?: string
  data?: Sent
}

function serialize(wire: Wire, value: unknown) {
  if (value === undefined) return value
  if (wire === "json") return JSON.parse(JSON.stringify(value)) as unknown
  if (wire === "structured-clone") return structuredClone(value)
  return value
}

type SendMessage = (message: unknown, callback?: (response: unknown) => void) => unknown

/**
 * Puts a serializing, lossy wire in front of `runtime.sendMessage` (which the messaging library
 * calls with a callback). `decide` is asked about every commit message: deliver it, deliver it but
 * lose the answer, never deliver it, or never answer.
 */
function installWire(
  wire: Wire,
  decide: (message: Envelope) => Decision | Promise<Decision> = () => "deliver",
) {
  const original = fakeBrowser.runtime.sendMessage.bind(fakeBrowser.runtime) as SendMessage
  const sent: Sent[] = []
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(((
    message: Envelope,
    callback?: (response: unknown) => void,
  ) => {
    if (message?.type !== COMMIT_MESSAGE_TYPE) return original(message, callback)
    sent.push({ ...message.data })
    void Promise.resolve(decide(message)).then((decision) => {
      if (decision === "hang") return
      if (decision === "lose") {
        callback?.(undefined)
        return
      }
      original(serialize(wire, message), (response) =>
        callback?.(decision === "drop-answer" ? undefined : serialize(wire, response)),
      )
    })
    return undefined
  }) as never)
  return sent
}

const OPENAI = "openai-default"

function withApiKey(config: Config, apiKey: string | undefined) {
  return {
    ...config,
    providersConfig: config.providersConfig.map((provider) =>
      provider.id === OPENAI ? { ...provider, apiKey } : provider,
    ),
  } as Config
}

function openAIOf(config: Config) {
  return config.providersConfig.find((provider) => provider.id === OPENAI)
}

function seeded() {
  return withApiKey(validConfig(), "sk-stored")
}

// The first message of a test loads the service lazily (see the test setup), so the limit is wide;
// the tests that wait for a limit to pass narrow it.
const FAST = { timeoutMs: 5000, retryDelaysMs: [1, 1, 1], maxConflictRounds: 4 }
const DEFAULTS = { ...commitClient, retryDelaysMs: [...commitClient.retryDelaysMs] }

beforeEach(async () => {
  resetStorage()
  Object.assign(commitClient, FAST)
  await seedPrimary(seeded(), committedMeta(seeded()))
})

afterEach(() => {
  Object.assign(commitClient, DEFAULTS)
})

describe.each<Wire>(["json", "structured-clone", "none"])(
  "a change sent over the message bus (%s)",
  (wire) => {
    it("commits a functional update that clears an optional provider field with undefined", async () => {
      installWire(wire)

      await editConfig((current) => withApiKey(current, undefined))

      const stored = openAIOf((await readRawPrimary()).value as Config)
      expect(stored).toMatchObject({ id: OPENAI, provider: "openai" })
      expect(stored).not.toHaveProperty("apiKey")
    })

    it("keeps a field that is cleared and set again in the same update", async () => {
      installWire(wire)

      await editConfig((current) => withApiKey(withApiKey(current, undefined), "sk-new"))

      expect(openAIOf((await readRawPrimary()).value as Config)).toMatchObject({
        apiKey: "sk-new",
      })
    })

    it("keeps arrays whole and in order, and an emptied array empty", async () => {
      installWire(wire)
      const patterns = ["c.example", "a.example", "b.example"]

      await editConfig((current) => ({
        ...current,
        floatingButton: { ...current.floatingButton, disabledFloatingButtonPatterns: patterns },
        selectionToolbar: { ...current.selectionToolbar, disabledSelectionToolbarPatterns: [] },
      }))

      const stored = (await readRawPrimary()).value as Config
      expect(stored.floatingButton.disabledFloatingButtonPatterns).toEqual(patterns)
      expect(stored.selectionToolbar.disabledSelectionToolbarPatterns).toEqual([])
    })

    it("stores the validated next value, and the pair it leaves is a committed one", async () => {
      installWire(wire)
      const next = { ...seeded(), contextMenu: { enabled: false } }

      await editConfig(() => next)

      const stored = await readRawPrimary()
      expect(stored.value).toEqual(configSchema.parse(next))
      expect(stored.meta).toMatchObject({ revision: 2, lastOpId: expect.any(String) })
    })

    it("computes again from the fresh snapshot when the data changed in the meantime", async () => {
      const other = withApiKey(
        { ...seeded(), glossary: { ...seeded().glossary, enabled: false } },
        "sk-other",
      )
      let interfered = false
      installWire(wire, async (message): Promise<Decision> => {
        if (message.data?.kind === "edit" && !interfered) {
          interfered = true
          // Another context commits while this one is still holding its snapshot.
          await seedPrimary(other, committedMeta(other, 7))
        }
        return "deliver"
      })
      const seen: Array<string | undefined> = []

      await editConfig((current) => {
        seen.push((openAIOf(current) as { apiKey?: string }).apiKey)
        return { ...current, floatingButton: { ...current.floatingButton, locked: true } }
      })

      expect(seen).toEqual(["sk-stored", "sk-other"])
      const stored = (await readRawPrimary()).value as Config
      // The change is applied to what the other context left, not to the stale snapshot.
      expect(stored.floatingButton.locked).toBe(true)
      expect(stored.glossary.enabled).toBe(false)
      expect(openAIOf(stored)).toMatchObject({ apiKey: "sk-other" })
      expect((await readRawPrimary()).meta).toMatchObject({ revision: 8 })
    })

    it("replaces an unusable config only after an exact copy of it is kept", async () => {
      installWire(wire)
      await seedPrimary(corruptConfig(), { schemaVersion: 111 })
      const original = await readRawPrimary()

      await replaceConfig(validConfig(), { backupCurrent: true, extensionVersion: "0.0.1" })

      expect((await readRawPrimary()).value).toEqual(configSchema.parse(validConfig()))
      const kept = await readPreserved()
      expect(kept).toHaveLength(1)
      expect(JSON.parse(kept[0]!.entry.encodedValue)).toEqual(original.value)
      expect(backupEntries(await snapshot())).toEqual([])
    })
  },
)

describe("an answer that is lost on the way", () => {
  function loseOnce(decision: Decision) {
    let first = true
    return (message: Envelope): Decision => {
      if (message.data?.kind === "edit" && first) {
        first = false
        return decision
      }
      return "deliver"
    }
  }

  async function revision() {
    return ((await readRawPrimary()).meta as { revision: number }).revision
  }

  it("is recognised when the same change is sent again: it is committed exactly once", async () => {
    const sent = installWire("json", loseOnce("drop-answer"))
    const before = await revision()

    await editConfig((current) => ({ ...current, contextMenu: { enabled: false } }))

    const edits = sent.filter((message) => message.kind === "edit")
    expect(edits.map((message) => message.attempt)).toEqual(["first", "uncertain-retry"])
    expect(new Set(edits.map((message) => message.opId)).size).toBe(1)
    expect(await revision()).toBe(before + 1)
    expect(((await readRawPrimary()).value as Config).contextMenu.enabled).toBe(false)
  })

  it("is applied once when the first attempt never arrived", async () => {
    const sent = installWire("json", loseOnce("lose"))
    const before = await revision()

    await editConfig((current) => ({ ...current, contextMenu: { enabled: false } }))

    expect(sent.filter((message) => message.kind === "edit")).toHaveLength(2)
    expect(await revision()).toBe(before + 1)
  })

  it("is not computed again when the retry finds other data: the outcome is reported as unknown", async () => {
    const other = { ...seeded(), glossary: { ...seeded().glossary, enabled: false } }
    let first = true
    installWire("json", async (message): Promise<Decision> => {
      if (message.data?.kind === "edit" && first) {
        first = false
        // The first attempt is lost, and before the retry another change is committed.
        await seedPrimary(other, committedMeta(other, 9))
        return "lose"
      }
      return "deliver"
    })
    let computed = 0

    await expect(
      editConfig((current) => {
        computed++
        return { ...current, contextMenu: { enabled: false } }
      }),
    ).rejects.toMatchObject({ name: "ConfigOutcomeUnknownError" })

    expect(computed).toBe(1)
    expect(((await readRawPrimary()).value as Config).contextMenu.enabled).not.toBe(false)
    expect(await revision()).toBe(9)
  })

  it("ends as 'unavailable' when nothing ever answers", async () => {
    commitClient.timeoutMs = 40
    const sent = installWire("json", () => "hang")

    await expect(editConfig((current) => current)).rejects.toMatchObject({
      name: "ConfigUnavailableError",
    })

    expect(sent.filter((message) => message.kind === "edit")).toHaveLength(
      FAST.retryDelaysMs.length + 1,
    )
  })

  it("ends as 'unavailable' when no attempt is ever delivered", async () => {
    installWire("json", () => "lose")

    await expect(editConfig((current) => current)).rejects.toMatchObject({
      name: "ConfigUnavailableError",
    })
    expect(await revision()).toBe(1)
  })
})

describe("the messages themselves", () => {
  it("mean the same after JSON and after structured clone: the service checks the digest it receives", async () => {
    const sent = installWire("none")

    // A cleared optional field is an `undefined` property: JSON drops it, structured clone keeps it.
    await editConfig((current) => withApiKey(current, undefined))
    await replaceConfig(validConfig(), { backupCurrent: true, extensionVersion: "0.0.1" })

    expect(sent.map((request) => request.kind)).toEqual(["edit", "replace"])
    for (const request of sent as unknown as OperationRequest[]) {
      const { opDigest, opId: _opId, attempt: _attempt, ...body } = request
      for (const received of [
        JSON.parse(JSON.stringify(body)) as typeof body,
        structuredClone(body),
      ]) {
        expect(operationDigest(received)).toBe(opDigest)
      }
    }
  })
})

// The service as the background attaches it, answering through the real listener. The fake browser
// delivers every message with an empty sender, so the tests trigger the listener themselves with
// the sender they want; what is asserted is that the sender reaches the service and decides.
describe("who is answered over the message bus", () => {
  const ID = fakeBrowser.runtime.id
  const PAGE = (name: string) => ({ id: ID, url: `chrome-extension://${ID}/${name}` })
  const CONTENT_SCRIPT = { id: ID, url: "https://example.com/article", tab: { id: 7 } }

  let detach: () => void
  let requestCounter = 0

  beforeEach(() => {
    const runtime = fakeBrowser.runtime as unknown as Record<symbol, unknown>
    ;(runtime[Symbol.for("lingotori.configCommitSeam.pause")] as (paused: boolean) => void)(true)
    detach = attachConfigCommitMessages(
      createConfigCommitService({ bootstrap: () => Promise.resolve() }),
    )
  })

  afterEach(() => {
    detach()
    const runtime = fakeBrowser.runtime as unknown as Record<symbol, unknown>
    ;(runtime[Symbol.for("lingotori.configCommitSeam.pause")] as (paused: boolean) => void)(false)
  })

  async function sendFrom(sender: object, request: unknown) {
    const message = { id: ++requestCounter, type: COMMIT_MESSAGE_TYPE, data: request, timestamp: 1 }
    let respond!: (response: unknown) => void
    const answer = new Promise<unknown>((resolve) => {
      respond = resolve
    })
    const results = await fakeBrowser.runtime.onMessage.trigger(message, sender, respond)
    expect(results).toContain(true)
    return (await answer) as { res?: { status: string; reason?: string }; err?: unknown }
  }

  async function operationOf(
    body: { kind: "edit"; next: Config } | { kind: "backup-now"; extensionVersion: string },
  ) {
    const full =
      body.kind === "edit" ? { ...body, base: fingerprintOf(await getConfigStatus()) } : body
    return {
      ...full,
      opId: `op-${++requestCounter}`,
      opDigest: operationDigest(full),
      attempt: "first",
    }
  }

  it("answers a settings page", async () => {
    const next = { ...seeded(), contextMenu: { enabled: false } }

    const response = await sendFrom(PAGE("options.html"), await operationOf({ kind: "edit", next }))

    expect(response.res?.status).toBe("committed")
    expect(((await readRawPrimary()).value as Config).contextMenu.enabled).toBe(false)
  })

  it("lets a content script change what a page's own controls change", async () => {
    const next = {
      ...seeded(),
      floatingButton: { ...seeded().floatingButton, locked: true },
    }

    const response = await sendFrom(CONTENT_SCRIPT, await operationOf({ kind: "edit", next }))

    expect(response.res?.status).toBe("committed")
    expect(((await readRawPrimary()).value as Config).floatingButton.locked).toBe(true)
  })

  it("refuses a content script's change to the providers, and writes nothing", async () => {
    const before = await readRawPrimary()
    const next = withApiKey(seeded(), "sk-from-a-page")

    const response = await sendFrom(CONTENT_SCRIPT, await operationOf({ kind: "edit", next }))

    expect(response.res).toEqual({ status: "refused", reason: "field-not-allowed-for-sender" })
    expect(await readRawPrimary()).toEqual(before)
  })

  it("refuses a content script a backup, and writes nothing", async () => {
    const before = await snapshot()

    const response = await sendFrom(
      CONTENT_SCRIPT,
      await operationOf({ kind: "backup-now", extensionVersion: "0.0.1" }),
    )

    expect(response.res).toEqual({ status: "refused", reason: "operation-not-allowed-for-sender" })
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    { name: "no sender at all", sender: {} },
    {
      name: "another extension",
      sender: {
        id: "another-extension-id",
        url: "chrome-extension://another-extension-id/options.html",
      },
    },
    {
      name: "this extension's id with a web page's address and no tab",
      sender: { id: ID, url: "https://example.com/" },
    },
    {
      name: "a page of this extension that is not a settings page",
      sender: PAGE("byos-callback.html"),
    },
  ])("refuses $name, and writes nothing", async ({ sender }) => {
    const before = await snapshot()
    const next = { ...seeded(), contextMenu: { enabled: false } }

    const response = await sendFrom(sender, await operationOf({ kind: "edit", next }))

    expect(response.res).toEqual({ status: "refused", reason: "sender-not-allowed" })
    expect(await snapshot()).toEqual(before)
  })
})
