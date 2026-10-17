import type { SenderEnvironment, SenderInfo } from "../config-commit-service"
import type { OperationRequest, Snapshot } from "@/utils/config/commit-protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configSchema } from "@/types/config/config"
import {
  ABSENT,
  backupEntries,
  committedMeta,
  corruptConfig,
  crashAtWrite,
  CURRENT_META,
  failWrites,
  holdFirstCall,
  PREVIOUS_META,
  preservedCopiesOf,
  previousVersionConfig,
  readPreserved,
  readRawPrimary,
  resetStorage,
  seedBackup,
  seedPreserved,
  seedPrimary,
  sameRaw,
  snapshot,
  trackPrimaryWrites,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { operationDigest } from "@/utils/config/commit-protocol"
import { recordInitFailure } from "@/utils/config/init-failure"
import { MAX_PRESERVED_ORIGINALS, PRESERVED_ORIGINAL_PREFIX } from "@/utils/config/preservation"
import {
  digestOfStoredValue,
  fingerprintOf,
  getConfigStatus,
  readRawConfigPair,
} from "@/utils/config/status"
import { editConfig } from "@/utils/config/write-guard"
import { MAX_BACKUPS_COUNT } from "@/utils/constants/backup"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { createConfigCommitService } from "../config-commit-service"

// The service is driven directly here (the messaging layer has its own tests): requests are built
// the way the client builds them, and the stored data is read back from the in-memory storage.
const EXTENSION_ID = "test-extension-id"
const ENVIRONMENT: SenderEnvironment = {
  extensionId: EXTENSION_ID,
  getUrl: () => `chrome-extension://${EXTENSION_ID}/`,
}
const PAGE: SenderInfo = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/options.html#/preference`,
}
const CONTENT_SCRIPT: SenderInfo = {
  id: EXTENSION_ID,
  url: "https://example.com/page",
  tab: { id: 7 },
}

let opCounter = 0

type Body = Parameters<typeof operationDigest>[0]
type Overrides = Partial<Pick<OperationRequest, "opId" | "attempt">>
type EditRequest = Extract<OperationRequest, { kind: "edit" }>
type ReplaceRequest = Extract<OperationRequest, { kind: "replace" }>

function operation(body: Body, overrides: Overrides = {}): OperationRequest {
  return {
    ...body,
    opId: `op-${++opCounter}`,
    opDigest: operationDigest(body),
    attempt: "first",
    ...overrides,
  }
}

async function tokenNow() {
  return fingerprintOf(await getConfigStatus())
}

async function editOf(next: unknown, overrides: Overrides = {}) {
  return operation(
    { kind: "edit", base: await tokenNow(), next: next as EditRequest["next"] },
    overrides,
  ) as EditRequest
}

async function replaceOf(
  next: unknown,
  options: { backupCurrent?: boolean } = {},
  overrides: Overrides = {},
) {
  return operation(
    {
      kind: "replace",
      base: await tokenNow(),
      next: next as ReplaceRequest["next"],
      backupCurrent: options.backupCurrent ?? true,
      extensionVersion: "0.0.1",
    },
    overrides,
  ) as ReplaceRequest
}

function newService(bootstrap: () => Promise<unknown> = () => Promise.resolve()) {
  return createConfigCommitService({ bootstrap }, ENVIRONMENT)
}

function edited(config = validConfig(), enabled = false) {
  return { ...config, contextMenu: { enabled } }
}

beforeEach(() => {
  resetStorage()
})

describe("who may ask", () => {
  it.each([
    { name: "no sender", sender: undefined },
    { name: "another extension", sender: { ...PAGE, id: "someone-else" } },
    { name: "a sender without an id", sender: { url: PAGE.url } },
    {
      name: "a sender that is neither a page of this extension nor a tab",
      sender: { id: EXTENSION_ID },
    },
    {
      name: "a page of this extension that is not a settings page",
      sender: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/byos-callback.html` },
    },
    {
      name: "a page that has this extension's id but another host",
      sender: { id: EXTENSION_ID, url: "chrome-extension://another-host/options.html" },
    },
  ])("refuses $name", async ({ sender }) => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const before = await snapshot()

    const response = await newService().handle({ kind: "snapshot" }, sender)

    expect(response).toEqual({ status: "refused", reason: "sender-not-allowed" })
    expect(await snapshot()).toEqual(before)
  })

  it.each(["/options.html", "/popup.html", "/sidepanel.html"])(
    "accepts the settings page %s, whatever its query or fragment",
    async (path) => {
      const sender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}${path}?tab=1#x` }

      const response = await newService().handle({ kind: "snapshot" }, sender)

      expect(response.status).toBe("snapshot")
    },
  )

  it("treats a web page that merely looks like a settings page as a content script", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const sender = { id: EXTENSION_ID, url: "https://evil.example/options.html", tab: { id: 1 } }

    const replace = await newService().handle(await replaceOf(validConfig()), sender)

    expect(replace).toEqual({ status: "refused", reason: "operation-not-allowed-for-sender" })
  })

  it("treats the settings page open in a tab as a settings page, not as a content script", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const sender = { ...PAGE, tab: { id: 3 } }

    const response = await newService().handle(await replaceOf(edited()), sender)

    expect(response.status).toBe("committed")
  })

  it.each([
    { name: "replace", build: () => replaceOf(validConfig()) },
    {
      name: "backup-now",
      build: () => operation({ kind: "backup-now", extensionVersion: "0.0.1" }),
    },
    {
      name: "remove-backup",
      build: () => operation({ kind: "remove-backup", backupId: "configBackup_1_x" }),
    },
    {
      name: "clear-backups",
      build: () => operation({ kind: "clear-backups", backupIds: ["configBackup_1_x"] }),
    },
    {
      name: "delete-preserved",
      build: () => operation({ kind: "delete-preserved", key: `${PRESERVED_ORIGINAL_PREFIX}x` }),
    },
  ])("does not let a content script ask for $name", async ({ build }) => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const before = await snapshot()

    const response = await newService().handle(await build(), CONTENT_SCRIPT)

    expect(response).toEqual({ status: "refused", reason: "operation-not-allowed-for-sender" })
    expect(await snapshot()).toEqual(before)
  })

  it("lets a content script edit what a page's own controls change", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const next = validConfig()
    next.floatingButton = { ...next.floatingButton, locked: !next.floatingButton.locked }
    next.pageTranslation = { ...next.pageTranslation, mode: "translationOnly" }
    next.selectionToolbar = { ...next.selectionToolbar, enabled: !next.selectionToolbar.enabled }
    next.language = { ...next.language, targetCode: "kor" }

    const response = await newService().handle(await editOf(next), CONTENT_SCRIPT)

    expect(response.status).toBe("committed")
    expect(((await readRawPrimary()).value as typeof next).language.targetCode).toBe("kor")
  })

  it.each([
    {
      name: "a provider's key",
      change: (config: ReturnType<typeof validConfig>) => ({
        ...config,
        providersConfig: config.providersConfig.map((provider, index) =>
          index === 0 ? { ...provider, apiKey: "changed-by-a-page" } : provider,
        ),
      }),
    },
    {
      name: "a provider's endpoint or name",
      change: (config: ReturnType<typeof validConfig>) => ({
        ...config,
        providersConfig: config.providersConfig.map((provider, index) =>
          index === 0 ? { ...provider, name: "renamed by a page" } : provider,
        ),
      }),
    },
    {
      name: "the interface language",
      change: (config: ReturnType<typeof validConfig>) => ({
        ...config,
        uiLanguage: config.uiLanguage === "ko" ? ("ja" as const) : ("ko" as const),
      }),
    },
  ])("does not let a content script change $name", async ({ change }) => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const before = await snapshot()

    const response = await newService().handle(await editOf(change(validConfig())), CONTENT_SCRIPT)

    expect(response).toEqual({ status: "refused", reason: "field-not-allowed-for-sender" })
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    { name: "no kind", request: {} },
    {
      name: "an unknown kind",
      request: { kind: "format-disk", opId: "a", opDigest: "b", attempt: "first" },
    },
    {
      name: "an operation without an id",
      request: { kind: "edit", opDigest: "b", attempt: "first" },
    },
    {
      name: "an operation with an unknown attempt",
      request: { kind: "edit", opId: "a", opDigest: "b", attempt: "later" },
    },
  ])("rejects a request with $name", async ({ request }) => {
    const response = await newService().handle(request as never, PAGE)

    expect(response.status).toBe("rejected")
  })
})

describe("an ordinary edit", () => {
  beforeEach(async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig(), 4))
  })

  it("is committed: the validated next value replaces the stored one, with a receipt", async () => {
    const request = await editOf(edited())
    const tracker = trackPrimaryWrites()

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("committed")
    expect(tracker.writes).toEqual([{ method: "set", keys: ["config", "config$"] }])
    const stored = await readRawPrimary()
    expect(stored.value).toEqual(configSchema.parse(edited()))
    expect(stored.meta).toMatchObject({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      revision: 5,
      lastOpId: request.opId,
      lastOpDigest: request.opDigest,
      valueDigest: digestOfStoredValue(stored.value),
    })
    expect(response).toMatchObject({ token: { kind: "usable", revision: 5 } })
  })

  it("replaces the stored value; it never merges into it", async () => {
    const stored = { ...validConfig(), keyOnlyTheStoredValueHas: true }
    await seedPrimary(stored, committedMeta(stored))

    await newService().handle(await editOf(edited()), PAGE)

    expect((await readRawPrimary()).value).not.toHaveProperty("keyOnlyTheStoredValueHas")
  })

  it("answers a definite conflict, and writes nothing, when the data changed since the snapshot", async () => {
    const request = await editOf(edited())
    await seedPrimary(edited(validConfig(), true), committedMeta(edited(validConfig(), true), 5))
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("conflict")
    const { snapshot: fresh } = response as { snapshot: Snapshot }
    expect(fresh.token).toEqual(await tokenNow())
    expect(fresh.config).toEqual(configSchema.parse(edited(validConfig(), true)))
    expect(await snapshot()).toEqual(before)
  })

  it("conflicts when only the meta changed (a revision went by with the same value)", async () => {
    const request = await editOf(edited())
    await seedPrimary(validConfig(), committedMeta(validConfig(), 9))

    expect((await newService().handle(request, PAGE)).status).toBe("conflict")
  })

  it("conflicts for a config written before revisions existed when its value changed", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const request = await editOf(edited())
    // Another context changed the value; the meta still carries no revision.
    await seedPrimary(edited(validConfig(), false), CURRENT_META)

    expect((await newService().handle(request, PAGE)).status).toBe("conflict")
  })

  it("is refused by the writer, with the reason startup recorded, for an older label whose upgrade failed and could not be kept as a copy", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    await recordInitFailure(await readRawConfigPair(), "invalid-schema")
    const before = await snapshot()

    await expect(editConfig((current) => current)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
      reason: "invalid-schema",
    })

    expect(await snapshot()).toEqual(before)
  })

  it("is refused as incoherent for a meta whose lastModifiedAt is there and undefined, and nothing is written", async () => {
    const meta = { schemaVersion: CONFIG_SCHEMA_VERSION, lastModifiedAt: undefined }
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: any[]
    ) => Promise<Record<string, unknown>>
    vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation((async (...args: any[]) => {
      const keys = args[0]
      if (Array.isArray(keys) && keys.includes("config") && keys.includes("config$")) {
        return { config: structuredClone(validConfig()), config$: structuredClone(meta) }
      }
      return realGet(...args)
    }) as any)
    const tracker = trackPrimaryWrites()
    const request = operation({
      kind: "edit",
      base: { kind: "suspect", revision: 0, valueHash: "x" },
      next: edited(),
    })

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("refused")
    expect(tracker.writes).toEqual([])
  })

  it("is refused when it was computed from the defaults that stand in for an unusable config", async () => {
    const request = operation({
      kind: "edit",
      base: { kind: "suspect", revision: 0, valueHash: "x" },
      next: edited(),
    })
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "refused", reason: "base-not-usable" })
    expect(await snapshot()).toEqual(before)
  })

  it.each([
    {
      name: "invalid",
      seed: () => seedPrimary(corruptConfig(), CURRENT_META),
      reason: "invalid-schema",
    },
    {
      name: "of a newer version",
      seed: () => seedPrimary(validConfig(), { schemaVersion: CONFIG_SCHEMA_VERSION + 1 }),
      reason: "newer-version",
    },
    {
      name: "torn",
      seed: () => seedPrimary(edited(), committedMeta(validConfig())),
      reason: "incoherent",
    },
    {
      name: "still labelled with an older version after startup",
      seed: () => seedPrimary(previousVersionConfig(), PREVIOUS_META),
      reason: "migration-failed",
    },
  ])(
    "is refused, and writes nothing, when the stored config is $name",
    async ({ seed, reason }) => {
      await seed()
      // The base comes from a usable snapshot taken before the stored data went bad.
      const request = operation({
        kind: "edit",
        base: { kind: "usable", revision: 0, valueHash: "earlier" },
        next: edited(),
      })
      const before = await snapshot()

      const response = await newService().handle(request, PAGE)

      expect(response).toEqual({ status: "refused", reason })
      expect(await snapshot()).toEqual(before)
    },
  )

  it("rejects a next value that does not validate, and writes nothing", async () => {
    const request = await editOf(corruptConfig())
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "rejected", reason: "invalid-next" })
    expect(await snapshot()).toEqual(before)
  })

  it("creates the config when nothing is stored", async () => {
    resetStorage()
    const request = await editOf(validConfig())

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("committed")
    expect(((await readRawPrimary()).meta as { revision: number }).revision).toBe(1)
  })

  it("does not report a commit it could not confirm", async () => {
    const request = await editOf(edited())
    const realSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local)
    vi.spyOn(fakeBrowser.storage.local, "set").mockImplementation(
      (items: Record<string, unknown>) => realSet({ config: items.config }),
    )

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "unavailable", reason: "storage-failed" })
  })

  it("answers that it is unavailable when the write fails", async () => {
    const request = await editOf(edited())
    failWrites((keys) => keys.includes("config"))
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "unavailable", reason: "storage-failed" })
    expect(await snapshot()).toEqual(before)
  })
})

describe("an operation that is sent again", () => {
  beforeEach(async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig(), 4))
  })

  it("is recognised as done when its first attempt was committed and the answer was lost", async () => {
    const service = newService()
    const request = await editOf(edited())
    await service.handle(request, PAGE)
    const afterFirst = await snapshot()

    const retry = await service.handle({ ...request, attempt: "uncertain-retry" }, PAGE)

    expect(retry.status).toBe("committed")
    expect(await snapshot()).toEqual(afterFirst)
  })

  it("is recognised as done when the first attempt is simply delivered twice", async () => {
    const service = newService()
    const request = await editOf(edited())
    await service.handle(request, PAGE)
    const afterFirst = await snapshot()

    const again = await service.handle(request, PAGE)

    expect(again.status).toBe("committed")
    expect(await snapshot()).toEqual(afterFirst)
  })

  it("is rejected when the same id comes with a different operation", async () => {
    const service = newService()
    const request = await editOf(edited())
    await service.handle(request, PAGE)
    const afterFirst = await snapshot()
    const other = {
      ...(await editOf(edited(validConfig(), true))),
      opId: request.opId,
      attempt: "uncertain-retry" as const,
    }

    const response = await service.handle(other, PAGE)

    expect(response).toEqual({ status: "rejected", reason: "op-digest-mismatch" })
    expect(await snapshot()).toEqual(afterFirst)
  })

  it("is applied when the first attempt never reached storage and the data is as it was", async () => {
    const request = await editOf(edited(), { attempt: "uncertain-retry" })

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("committed")
    expect(((await readRawPrimary()).value as { contextMenu: unknown }).contextMenu).toEqual({
      enabled: false,
    })
  })

  it("stops with 'unknown' when the data changed, instead of computing again", async () => {
    const request = await editOf(edited(), { attempt: "uncertain-retry" })
    await seedPrimary(edited(validConfig(), true), committedMeta(edited(validConfig(), true), 9))
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "outcome-unknown" })
    expect(await snapshot()).toEqual(before)
  })

  it("is still recognised after a restart: a new service reads the receipt from storage", async () => {
    const request = await editOf(edited())
    await newService().handle(request, PAGE)
    const afterFirst = await snapshot()

    const restarted = newService()
    const retry = await restarted.handle({ ...request, attempt: "uncertain-retry" }, PAGE)

    expect(retry.status).toBe("committed")
    expect(await snapshot()).toEqual(afterFirst)
  })
})

describe("an explicit replacement (restore, import, reset)", () => {
  it("backs up a usable config as stored, under an id derived from the operation, then commits", async () => {
    const stored = { ...validConfig(), contextMenu: { enabled: false } }
    await seedPrimary(stored, committedMeta(stored, 2))
    const request = await replaceOf(validConfig())

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("committed")
    const { backupId } = response as { backupId: string }
    expect(backupId.endsWith(`_${request.opId}`)).toBe(true)
    const backups = backupEntries(await snapshot())
    expect(backups.map(({ id }) => id)).toEqual([backupId])
    expect(backups[0]!.backup).toEqual({ schemaVersion: CONFIG_SCHEMA_VERSION, config: stored })
    expect((await readRawPrimary()).value).toEqual(configSchema.parse(validConfig()))
  })

  it("takes no backup when it is not asked to, or when the latest one already holds the config", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    await newService().handle(await replaceOf(edited(), { backupCurrent: false }), PAGE)
    expect(backupEntries(await snapshot())).toEqual([])

    await seedPrimary(validConfig(), committedMeta(validConfig(), 3))
    await seedBackup(validConfig(), 1_000)
    await newService().handle(await replaceOf(edited()), PAGE)
    expect(backupEntries(await snapshot())).toHaveLength(1)
  })

  it("keeps an exact, confirmed copy of an unusable config instead of a backup, then replaces it", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const original = await readRawPrimary()

    const response = await newService().handle(await replaceOf(validConfig()), PAGE)

    expect(response.status).toBe("committed")
    const copies = preservedCopiesOf(await snapshot(), original)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("invalid-schema")
    expect(backupEntries(await snapshot())).toEqual([])
    expect((await readRawPrimary()).value).toEqual(configSchema.parse(validConfig()))
  })

  it.each([
    {
      name: "of a newer version",
      pair: { value: validConfig(), meta: { schemaVersion: 999 } },
      reason: "newer-version",
    },
    {
      name: "with a meta that cannot be read",
      pair: { value: validConfig(), meta: "x" },
      reason: "incoherent",
    },
    { name: "a corrupted falsy value", pair: { value: 0, meta: ABSENT }, reason: "invalid-schema" },
  ])("keeps the stored pair as it is, $name", async ({ pair, reason }) => {
    await seedPrimary(pair.value, pair.meta)
    const original = await readRawPrimary()

    await newService().handle(await replaceOf(validConfig()), PAGE)

    const copies = preservedCopiesOf(await snapshot(), original)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe(reason)
  })

  it("keeps a config whose migration failed, as migration-failed, once startup has run", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const original = await readRawPrimary()

    const response = await newService().handle(await replaceOf(validConfig()), PAGE)

    expect(response.status).toBe("committed")
    expect(preservedCopiesOf(await snapshot(), original)[0]!.entry.reason).toBe("migration-failed")
  })

  it("replaces nothing when the copy cannot be written", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const request = await replaceOf(validConfig())
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_ORIGINAL_PREFIX)))
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "refused", reason: "preservation-failed" })
    expect(await snapshot()).toEqual(before)
  })

  it("replaces nothing when the store of copies is full", async () => {
    await seedPrimary(corruptConfig("current"), CURRENT_META)
    for (let n = 0; n < MAX_PRESERVED_ORIGINALS; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    const request = await replaceOf(validConfig())
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "refused", reason: "preservation-full" })
    expect(await snapshot()).toEqual(before)
  })

  it("is strict about the limit: the queue serializes captures, so a sixth never gets in", async () => {
    const service = newService()
    const attempts = []
    for (let n = 0; n < MAX_PRESERVED_ORIGINALS + 2; n++) {
      await seedPrimary(corruptConfig(`original-${n}`), CURRENT_META)
      attempts.push(await replaceOf(validConfig(), { backupCurrent: false }))
      // Each replacement is sent at once; the queue answers them one after another.
      await service.handle(attempts[n]!, PAGE)
    }

    expect(await readPreserved()).toHaveLength(MAX_PRESERVED_ORIGINALS)
  })

  it("takes back the backup it added when the commit fails, so a replacement that did not happen changes nothing", async () => {
    const stored = { ...validConfig(), contextMenu: { enabled: false } }
    await seedPrimary(stored, committedMeta(stored))
    for (let n = 0; n < MAX_BACKUPS_COUNT; n++) await seedBackup(validConfig(), 1_000 + n)
    const request = await replaceOf(validConfig())
    failWrites((keys) => keys.includes("config"))
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response).toEqual({ status: "unavailable", reason: "storage-failed" })
    expect(await snapshot()).toEqual(before)
  })

  it("rotates the oldest backup out only after the replacement is committed", async () => {
    const stored = { ...validConfig(), contextMenu: { enabled: false } }
    await seedPrimary(stored, committedMeta(stored))
    const oldest = await seedBackup(validConfig(), 1_000)
    for (let n = 1; n < MAX_BACKUPS_COUNT; n++) await seedBackup(validConfig(), 1_000 + n)

    await newService().handle(await replaceOf(validConfig()), PAGE)

    const ids = backupEntries(await snapshot()).map(({ id }) => id)
    expect(ids).toHaveLength(MAX_BACKUPS_COUNT)
    expect(ids).not.toContain(oldest)
  })

  it("conflicts, and writes nothing, when the data changed since it was prepared", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const request = await replaceOf(edited())
    await seedPrimary(validConfig(), committedMeta(validConfig(), 6))
    const before = await snapshot()

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("conflict")
    expect(await snapshot()).toEqual(before)
  })

  it("takes only one backup when it is sent again after the commit failed", async () => {
    const stored = { ...validConfig(), contextMenu: { enabled: false } }
    await seedPrimary(stored, committedMeta(stored))
    const request = await replaceOf(validConfig())
    // The first attempt: the backup is added, then the process dies before the commit.
    crashAtWrite(3)
    const service = newService()
    await service.handle(request, PAGE)
    vi.restoreAllMocks()
    expect(backupEntries(await snapshot()).length).toBeLessThanOrEqual(1)

    const retry = await newService().handle({ ...request, attempt: "uncertain-retry" }, PAGE)

    expect(retry.status).toBe("committed")
    expect(backupEntries(await snapshot())).toHaveLength(1)
  })

  it("never makes a second backup under an operation id that already has one, whatever it holds", async () => {
    const stored = { ...validConfig(), contextMenu: { enabled: false } }
    await seedPrimary(stored, committedMeta(stored))
    const request = await replaceOf(validConfig())
    // An earlier attempt of this operation made a backup; the latest backup does not hold what is
    // stored now, so only the operation id says it is already there.
    const id = await seedBackup(validConfig(), 5_000, `configBackup_5000_${request.opId}`)

    const response = await newService().handle(request, PAGE)

    expect(response.status).toBe("committed")
    expect(backupEntries(await snapshot()).map((entry) => entry.id)).toEqual([id])
  })
})

describe("a replacement over an older label whose upgrade failed and left no copy", () => {
  it("keeps the exact copy under the reason startup recorded, then replaces", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const original = await readRawPrimary()
    await recordInitFailure(await readRawConfigPair(), "invalid-schema")

    const response = await newService().handle(await replaceOf(validConfig()), PAGE)

    expect(response.status).toBe("committed")
    const copies = preservedCopiesOf(await snapshot(), original)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("invalid-schema")
  })
})

describe("recovery that is interrupted", () => {
  it("leaves a kept copy next to an unchanged unusable config when the process stops between them", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const original = await readRawPrimary()
    const request = await replaceOf(validConfig(), { backupCurrent: false })
    // Write 1 is the copy; write 2 would be the commit.
    crashAtWrite(2)

    const first = await newService().handle(request, PAGE)

    expect(first.status).toBe("unavailable")
    vi.restoreAllMocks()
    expect(sameRaw(await readRawPrimary(), original)).toBe(true)
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
  })

  it("finishes the replacement when a restarted service gets the same operation again", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const original = await readRawPrimary()
    const request = await replaceOf(validConfig(), { backupCurrent: false })
    crashAtWrite(2)
    await newService().handle(request, PAGE)
    vi.restoreAllMocks()

    const retry = await newService().handle({ ...request, attempt: "uncertain-retry" }, PAGE)

    expect(retry.status).toBe("committed")
    expect((await readRawPrimary()).value).toEqual(configSchema.parse(validConfig()))
    // Still exactly one copy: the second capture found the first.
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
  })

  it("keeps the original safe at every write a stop can interrupt", async () => {
    for (let stopAt = 1; stopAt <= 4; stopAt++) {
      resetStorage()
      await seedPrimary(corruptConfig(), CURRENT_META)
      const original = await readRawPrimary()
      const request = await replaceOf(validConfig())
      crashAtWrite(stopAt)

      await newService().handle(request, PAGE)
      vi.restoreAllMocks()

      const primaryKept = sameRaw(await readRawPrimary(), original)
      const copyKept = preservedCopiesOf(await snapshot(), original).length === 1
      expect(primaryKept || copyKept, `the original after a stop at write ${stopAt}`).toBe(true)
    }
  })

  it("re-keeps and confirms a copy that the user deleted in the meantime, before it replaces", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const original = await readRawPrimary()
    const service = newService()
    const key = await seedPreserved(original)

    const deleted = await service.handle(operation({ kind: "delete-preserved", key }), PAGE)
    expect(deleted.status).toBe("committed")
    expect(await readPreserved()).toEqual([])
    // The stored config is still unusable, so a later replacement keeps the copy again first.
    const replaced = await service.handle(
      await replaceOf(validConfig(), { backupCurrent: false }),
      PAGE,
    )

    expect(replaced.status).toBe("committed")
    expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
  })

  it("refuses to follow a torn pair: it is unusable and kept as it is", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    // A write that reached the value but not the meta (a native tear).
    await fakeBrowser.storage.local.set({ config: edited() })
    const torn = await readRawPrimary()

    const edit = await newService().handle(
      operation({
        kind: "edit",
        base: { kind: "usable", revision: 1, valueHash: "earlier" },
        next: edited(validConfig(), true),
      }),
      PAGE,
    )
    expect(edit).toEqual({ status: "refused", reason: "incoherent" })

    await newService().handle(await replaceOf(validConfig(), { backupCurrent: false }), PAGE)
    expect(preservedCopiesOf(await snapshot(), torn)[0]!.entry.reason).toBe("incoherent")
  })
})

describe("backups", () => {
  it("backs up the config exactly as stored, under an id derived from the operation", async () => {
    const stored = { ...validConfig(), keyKeptAsStored: 1 }
    await seedPrimary(stored, committedMeta(stored))
    const request = operation({ kind: "backup-now", extensionVersion: "0.0.1" })

    const response = await newService().handle(request, PAGE)

    const { backupId } = response as { backupId: string }
    expect(backupId.endsWith(`_${request.opId}`)).toBe(true)
    expect(backupEntries(await snapshot())[0]!.backup).toEqual({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      config: stored,
    })
  })

  it.each([
    {
      name: "unusable",
      seed: () => seedPrimary(corruptConfig(), CURRENT_META),
      reason: "invalid-schema",
    },
    {
      name: "still labelled with an older version",
      seed: () => seedPrimary(previousVersionConfig(), PREVIOUS_META),
      reason: "migration-failed",
    },
    { name: "absent", seed: async () => {}, reason: "nothing-to-back-up" },
  ])("refuses to back up a config that is $name", async ({ seed, reason }) => {
    await seed()
    const before = await snapshot()

    const response = await newService().handle(
      operation({ kind: "backup-now", extensionVersion: "0.0.1" }),
      PAGE,
    )

    expect(response).toEqual({ status: "refused", reason })
    expect(await snapshot()).toEqual(before)
  })

  it("is done when sent again after it was made, and never made again when the first attempt cannot be found", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const service = newService()
    const request = operation({ kind: "backup-now", extensionVersion: "0.0.1" })
    await service.handle(request, PAGE)

    const retry = await service.handle({ ...request, attempt: "uncertain-retry" }, PAGE)
    expect(retry.status).toBe("committed")
    expect(backupEntries(await snapshot())).toHaveLength(1)

    const lost = operation(
      { kind: "backup-now", extensionVersion: "0.0.1" },
      { attempt: "uncertain-retry" },
    )
    const unknown = await service.handle(lost, PAGE)
    expect(unknown).toEqual({ status: "outcome-unknown" })
    expect(backupEntries(await snapshot())).toHaveLength(1)
  })

  it("removes a backup, and removing one that is already gone is not an error", async () => {
    const id = await seedBackup(validConfig(), 1_000)
    const service = newService()

    expect(
      (await service.handle(operation({ kind: "remove-backup", backupId: id }), PAGE)).status,
    ).toBe("committed")
    expect(backupEntries(await snapshot())).toEqual([])
    expect(
      (await service.handle(operation({ kind: "remove-backup", backupId: id }), PAGE)).status,
    ).toBe("committed")
  })

  it.each([
    {
      name: "remove-backup",
      request: () => operation({ kind: "remove-backup", backupId: "config" }),
    },
    {
      name: "clear-backups",
      request: () =>
        operation({ kind: "clear-backups", backupIds: ["configBackup_1_a", "config$"] }),
    },
  ])("rejects a $name request that names a key that is not a backup", async ({ request }) => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const before = await snapshot()

    const response = await newService().handle(request(), PAGE)

    expect(response).toEqual({ status: "rejected", reason: "malformed-request" })
    expect(await snapshot()).toEqual(before)
  })

  it("clears exactly the backups it was given, also when repeated, and never a newer one", async () => {
    const first = await seedBackup(validConfig(), 1_000)
    const second = await seedBackup(validConfig(), 2_000)
    const service = newService()
    const request = operation({ kind: "clear-backups", backupIds: [first, second] })
    const newer = await seedBackup(validConfig(), 3_000)

    await service.handle(request, PAGE)
    await service.handle({ ...request, attempt: "uncertain-retry" }, PAGE)

    expect(backupEntries(await snapshot()).map(({ id }) => id)).toEqual([newer])
  })

  it("deletes a kept original on request, idempotently, and refuses any other key", async () => {
    const key = await seedPreserved({ value: corruptConfig(), meta: CURRENT_META })
    const service = newService()

    expect((await service.handle(operation({ kind: "delete-preserved", key }), PAGE)).status).toBe(
      "committed",
    )
    expect(await readPreserved()).toEqual([])
    expect((await service.handle(operation({ kind: "delete-preserved", key }), PAGE)).status).toBe(
      "committed",
    )

    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const response = await service.handle(
      operation({ kind: "delete-preserved", key: "config" }),
      PAGE,
    )
    expect(response).toEqual({ status: "rejected", reason: "malformed-request" })
    expect((await readRawPrimary()).value).toEqual(validConfig())
  })
})

describe("the hourly backup", () => {
  it("backs up a usable config once and skips it while the latest backup holds it", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const service = newService()

    expect(await service.backUpIfChanged("0.0.1")).toEqual(expect.any(String))
    expect(await service.backUpIfChanged("0.0.1")).toBeUndefined()
    expect(backupEntries(await snapshot())).toHaveLength(1)
  })

  it.each([
    { name: "unusable", seed: () => seedPrimary(corruptConfig(), CURRENT_META) },
    { name: "torn", seed: () => seedPrimary(edited(), committedMeta(validConfig())) },
    {
      name: "still being migrated",
      seed: () => seedPrimary(previousVersionConfig(), PREVIOUS_META),
    },
    { name: "absent", seed: async () => {} },
  ])("skips a config that is $name", async ({ seed }) => {
    await seed()

    expect(await newService().backUpIfChanged("0.0.1")).toBeUndefined()
    expect(backupEntries(await snapshot())).toEqual([])
  })
})

describe("startup and the queue", () => {
  it("holds every operation until startup has finished, and answers none of them early", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve
    })
    const bootstrap = vi.fn<() => Promise<void>>(() => startup)
    const service = newService(bootstrap)
    const request = await editOf(edited())
    const tracker = trackPrimaryWrites()

    const pending = service.handle(request, PAGE)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tracker.writes).toEqual([])

    finishStartup()
    expect((await pending).status).toBe("committed")
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it("lets an edit see the value startup produced, never the one it started from", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const service = newService(async () => {
      // Stands in for a successful migration: the stored config is brought to the current version.
      await seedPrimary(validConfig(), committedMeta(validConfig(), 1))
    })
    // The request was computed (by a page that read the stored data) before startup finished.
    const early = operation({
      kind: "edit",
      base: { kind: "usable", revision: 0, valueHash: "before-startup" },
      next: edited(),
    })

    const response = await service.handle(early, PAGE)

    expect(response.status).toBe("conflict")
  })

  it("answers 'unavailable' instead of waiting when startup failed", async () => {
    const service = newService(() => Promise.reject(new Error("startup failed")))

    const response = await service.handle(await editOf(edited()), PAGE)

    expect(response).toEqual({ status: "unavailable", reason: "bootstrap-failed" })
    expect(await service.backUpIfChanged("0.0.1")).toBeUndefined()
  })

  it("runs the operations in the order they arrive", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const service = newService()
    const first = await editOf(edited(validConfig(), false))
    // The second request is computed from the same data as the first.
    const second = operation({
      kind: "edit",
      base: first.base,
      next: edited(validConfig(), true),
    })
    const gate = holdFirstCall("get", (keys) => keys.includes("config"))

    const a = service.handle(first, PAGE)
    await gate.reached
    const b = service.handle(second, PAGE)
    gate.release()

    expect((await a).status).toBe("committed")
    // It was computed from data that the first has changed by now, so it conflicts.
    expect((await b).status).toBe("conflict")
  })

  it("keeps working after an operation failed", async () => {
    await seedPrimary(validConfig(), committedMeta(validConfig()))
    const service = newService()
    failWrites((keys) => keys.includes("config"), 1)
    const failing = await service.handle(await editOf(edited()), PAGE)
    expect(failing.status).toBe("unavailable")

    const next = await service.handle(await editOf(edited()), PAGE)

    expect(next.status).toBe("committed")
  })

  it("can have the real startup as its first job, and an edit made right after it succeeds", async () => {
    const { initializeConfig } = await import("@/utils/config/init")
    const service = newService(() => initializeConfig())

    const response = await service.handle(
      operation({
        kind: "edit",
        base: { kind: "absent", revision: 0, valueHash: "absent" },
        next: validConfig(),
      }),
      PAGE,
    )

    // Startup created the config first, so a request computed from "nothing stored" is stale.
    expect(response.status).toBe("conflict")
    const fresh = await service.handle({ kind: "snapshot" }, PAGE)
    expect(fresh.status).toBe("snapshot")
    expect((fresh as { snapshot: Snapshot }).snapshot.token.kind).toBe("usable")
  })
})
