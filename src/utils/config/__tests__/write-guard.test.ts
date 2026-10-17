import type { CommitRequest, CommitResponse, OperationRequest, Snapshot } from "../commit-protocol"
import type { BaseToken } from "../status"
import type { Config } from "@/types/config/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { operationDigest, setInProcessCommitHandler } from "../commit-protocol"
import { fingerprintOf, getConfigStatus } from "../status"
import {
  backUpNow,
  clearBackupsById,
  commitClient,
  deletePreservedById,
  editConfig,
  removeBackupById,
  replaceConfig,
} from "../write-guard"
import {
  committedMeta,
  corruptConfig,
  PREVIOUS_META,
  previousVersionConfig,
  resetStorage,
  seedPrimary,
  validConfig,
} from "./preservation-test-kit"

// The client side of the settings service, against a service that answers as the test scripts it.
// The service itself is tested in `config-commit-service.test.ts`; what is asserted here is what a
// writer sends, how it reacts to each answer, and which error it ends with.
type Handler = (request: CommitRequest) => Promise<CommitResponse>

const handler = vi.fn<Handler>()

const FAST = { timeoutMs: 30, retryDelaysMs: [1, 1, 1], maxConflictRounds: 3 }
const DEFAULTS = { ...commitClient, retryDelaysMs: [...commitClient.retryDelaysMs] }

const COMMITTED: CommitResponse = { status: "committed" }

function snapshotOf(config: Config | null, revision = 5): Snapshot {
  const token: BaseToken = {
    kind: config ? "usable" : "absent",
    revision,
    valueHash: `h${revision}`,
  }
  return { token, config }
}

function lastRequest() {
  return handler.mock.calls.at(-1)![0] as OperationRequest
}

beforeEach(async () => {
  resetStorage()
  handler.mockReset()
  Object.assign(commitClient, FAST)
  setInProcessCommitHandler(handler)
  await seedPrimary(validConfig(), committedMeta(validConfig(), 3))
})

afterEach(() => {
  setInProcessCommitHandler(undefined)
  Object.assign(commitClient, DEFAULTS)
})

describe("an ordinary edit", () => {
  it("computes the next config from the stored one and sends it with the snapshot's token", async () => {
    handler.mockResolvedValue(COMMITTED)
    const token = fingerprintOf(await getConfigStatus())

    const committed = await editConfig((current) => ({
      ...current,
      contextMenu: { enabled: !current.contextMenu.enabled },
    }))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(lastRequest()).toMatchObject({ kind: "edit", base: token, attempt: "first" })
    expect((lastRequest() as { next: Config }).next.contextMenu.enabled).toBe(
      !validConfig().contextMenu.enabled,
    )
    expect(committed.contextMenu.enabled).toBe(!validConfig().contextMenu.enabled)
  })

  it("identifies the operation by its content, and gives every operation its own id", async () => {
    handler.mockResolvedValue(COMMITTED)

    await editConfig((current) => current)
    const first = lastRequest()
    await editConfig((current) => current)
    const second = lastRequest()

    const { opId, opDigest, attempt, ...body } = first
    expect(opDigest).toBe(operationDigest(body))
    expect(attempt).toBe("first")
    expect(second.opId).not.toBe(opId)
    expect(second.opDigest).toBe(opDigest)
  })

  it("starts from the defaults when nothing is stored", async () => {
    resetStorage()
    handler.mockResolvedValue(COMMITTED)
    const seen: Config[] = []

    await editConfig((current) => {
      seen.push(current)
      return current
    })

    expect(seen).toEqual([DEFAULT_CONFIG])
    expect(lastRequest()).toMatchObject({ kind: "edit", base: { kind: "absent" } })
  })

  it("does not send anything for a stored config that cannot be used", async () => {
    await seedPrimary(corruptConfig(), { schemaVersion: 111 })
    const compute = vi.fn<(current: Config) => Config>((current) => current)

    await expect(editConfig(compute)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
      reason: "invalid-schema",
    })

    expect(compute).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("does not send a next config that does not validate", async () => {
    await expect(
      editConfig((current) => ({ ...current, contextMenu: { enabled: "yes" } }) as never),
    ).rejects.toThrow("Config is invalid")

    expect(handler).not.toHaveBeenCalled()
  })

  it("asks the service for the snapshot of a config that is still being upgraded", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    const answered = snapshotOf(validConfig(), 8)
    handler.mockImplementation((request) =>
      Promise.resolve(
        request.kind === "snapshot" ? { status: "snapshot", snapshot: answered } : COMMITTED,
      ),
    )

    await editConfig((current) => current)

    expect(handler.mock.calls[0]![0]).toEqual({ kind: "snapshot" })
    expect(lastRequest()).toMatchObject({ kind: "edit", base: answered.token })
  })

  it("stops with the service's reason when the snapshot of an upgrading config is refused", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    handler.mockResolvedValue({ status: "refused", reason: "migration-failed" })

    await expect(editConfig((current) => current)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
      reason: "migration-failed",
    })
  })
})

describe("a conflict", () => {
  it("computes again with the same updater from the fresh snapshot, and sends that snapshot's token", async () => {
    const fresh = snapshotOf({
      ...validConfig(),
      floatingButton: { ...validConfig().floatingButton, locked: true },
    })
    handler
      .mockResolvedValueOnce({ status: "conflict", snapshot: fresh })
      .mockResolvedValue(COMMITTED)
    const seen: boolean[] = []

    await editConfig((current) => {
      seen.push(current.floatingButton.locked)
      return { ...current, contextMenu: { enabled: false } }
    })

    expect(seen).toEqual([false, true])
    expect(handler).toHaveBeenCalledTimes(2)
    expect(lastRequest()).toMatchObject({ kind: "edit", base: fresh.token })
    expect((lastRequest() as { next: Config }).next.floatingButton.locked).toBe(true)
  })

  it("gives each round its own operation, so a repeat of one is never taken for another", async () => {
    handler
      .mockResolvedValueOnce({ status: "conflict", snapshot: snapshotOf(validConfig(), 6) })
      .mockResolvedValue(COMMITTED)

    await editConfig((current) => ({ ...current, contextMenu: { enabled: false } }))

    const ids = handler.mock.calls.map(([request]) => (request as OperationRequest).opId)
    expect(new Set(ids).size).toBe(2)
  })

  it("gives up after the configured number of rounds, with a conflict error, having written nothing itself", async () => {
    handler.mockImplementation(() =>
      Promise.resolve({ status: "conflict", snapshot: snapshotOf(validConfig(), 9) }),
    )
    const compute = vi.fn<(current: Config) => Config>((current) => current)

    await expect(editConfig(compute)).rejects.toMatchObject({ name: "ConfigConflictError" })

    expect(handler).toHaveBeenCalledTimes(FAST.maxConflictRounds + 1)
    expect(compute).toHaveBeenCalledTimes(FAST.maxConflictRounds + 1)
  })

  it("stops when the fresh snapshot says the stored config cannot be used", async () => {
    handler.mockResolvedValue({
      status: "conflict",
      snapshot: {
        token: { kind: "suspect", revision: 0, valueHash: "x" },
        config: null,
        unusable: "newer-version",
      },
    })

    await expect(editConfig((current) => current)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
      reason: "newer-version",
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("the answers that are not 'committed'", () => {
  it.each([
    {
      response: { status: "refused", reason: "invalid-schema" },
      name: "ConfigRecoveryRequiredError",
      reason: "invalid-schema",
    },
    {
      response: { status: "refused", reason: "migration-failed" },
      name: "ConfigRecoveryRequiredError",
      reason: "migration-failed",
    },
    {
      response: { status: "refused", reason: "newer-version" },
      name: "ConfigRecoveryRequiredError",
      reason: "newer-version",
    },
    {
      response: { status: "refused", reason: "incoherent" },
      name: "ConfigRecoveryRequiredError",
      reason: "incoherent",
    },
    {
      response: { status: "refused", reason: "preservation-full" },
      name: "PreservationError",
      code: "full",
    },
    {
      response: { status: "refused", reason: "preservation-failed" },
      name: "PreservationError",
      code: "write-failed",
    },
    {
      response: { status: "refused", reason: "sender-not-allowed" },
      name: "ConfigRefusedError",
      reason: "sender-not-allowed",
    },
    {
      response: { status: "refused", reason: "field-not-allowed-for-sender" },
      name: "ConfigRefusedError",
      reason: "field-not-allowed-for-sender",
    },
    {
      response: { status: "refused", reason: "base-not-usable" },
      name: "ConfigRefusedError",
      reason: "base-not-usable",
    },
    {
      response: { status: "rejected", reason: "invalid-next" },
      name: "ConfigRefusedError",
      reason: "invalid-next",
    },
    { response: { status: "outcome-unknown" }, name: "ConfigOutcomeUnknownError" },
    {
      response: { status: "unavailable", reason: "bootstrap-failed" },
      name: "ConfigUnavailableError",
    },
    {
      response: { status: "unavailable", reason: "storage-failed" },
      name: "ConfigUnavailableError",
    },
  ] satisfies Array<{ response: CommitResponse; name: string; reason?: string; code?: string }>)(
    "$response.status ($response.reason) ends the edit as $name",
    async ({ response, ...expected }) => {
      handler.mockResolvedValue(response)

      await expect(editConfig((current) => current)).rejects.toMatchObject(expected)

      // None of them is retried or computed again: only a lost answer is.
      expect(handler).toHaveBeenCalledTimes(1)
    },
  )

  it("treats a snapshot answer to an edit as unexpected", async () => {
    handler.mockResolvedValue({ status: "snapshot", snapshot: snapshotOf(validConfig()) })

    await expect(editConfig((current) => current)).rejects.toThrow("Unexpected answer")
  })

  it("says there is nothing to back up as a plain error", async () => {
    handler.mockResolvedValue({ status: "refused", reason: "nothing-to-back-up" })

    await expect(backUpNow("0.0.1")).rejects.toThrow("no saved settings")
  })
})

describe("an answer that is lost", () => {
  it("sends the same operation again, marked as a retry, and returns the answer of the retry", async () => {
    handler.mockRejectedValueOnce(new Error("port closed")).mockResolvedValue(COMMITTED)

    await editConfig((current) => ({ ...current, contextMenu: { enabled: false } }))

    const [first, retry] = handler.mock.calls.map(([request]) => request as OperationRequest)
    expect(first!.attempt).toBe("first")
    expect(retry!.attempt).toBe("uncertain-retry")
    expect(retry!.opId).toBe(first!.opId)
    expect(retry!.opDigest).toBe(first!.opDigest)
    expect({ ...retry, attempt: "first" }).toEqual(first)
  })

  it("keeps marking every further attempt as a retry", async () => {
    handler
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValue(COMMITTED)

    await editConfig((current) => current)

    expect(handler.mock.calls.map(([request]) => (request as OperationRequest).attempt)).toEqual([
      "first",
      "uncertain-retry",
      "uncertain-retry",
    ])
  })

  it("treats an answer that does not come in time as lost", async () => {
    handler
      .mockImplementationOnce(() => new Promise<CommitResponse>(() => {}))
      .mockResolvedValue(COMMITTED)

    await editConfig((current) => current)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(lastRequest().attempt).toBe("uncertain-retry")
  })

  it("ends as 'unavailable', with the last failure as its cause, when no attempt is answered", async () => {
    handler.mockRejectedValue(new Error("no receiver"))

    const failure = await editConfig((current) => current).catch((error: unknown) => error)

    expect(failure).toMatchObject({ name: "ConfigUnavailableError" })
    expect((failure as Error).cause).toMatchObject({ message: "no receiver" })
    expect(handler).toHaveBeenCalledTimes(FAST.retryDelaysMs.length + 1)
  })

  it("does not mark a snapshot request, which changes nothing, as a retry", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    handler
      .mockRejectedValueOnce(new Error("lost"))
      .mockImplementation((request) =>
        Promise.resolve(
          request.kind === "snapshot"
            ? { status: "snapshot", snapshot: snapshotOf(validConfig()) }
            : COMMITTED,
        ),
      )

    await editConfig((current) => current)

    expect(handler.mock.calls.slice(0, 2).map(([request]) => request)).toEqual([
      { kind: "snapshot" },
      { kind: "snapshot" },
    ])
  })
})

describe("an explicit replacement", () => {
  const OPTIONS = { backupCurrent: true, extensionVersion: "0.0.1" }

  it("sends the validated config with the token of what is stored and the backup choice", async () => {
    handler.mockResolvedValue(COMMITTED)
    const token = fingerprintOf(await getConfigStatus())
    const next = { ...validConfig(), contextMenu: { enabled: false } }

    await replaceConfig(next, OPTIONS)

    expect(lastRequest()).toMatchObject({
      kind: "replace",
      base: token,
      backupCurrent: true,
      extensionVersion: "0.0.1",
    })
  })

  it("reads the token of what is stored again for every round after a conflict", async () => {
    handler
      .mockImplementationOnce(async () => {
        await seedPrimary(validConfig(), committedMeta(validConfig(), 4))
        return { status: "conflict", snapshot: snapshotOf(validConfig(), 4) }
      })
      .mockResolvedValue(COMMITTED)

    await replaceConfig(validConfig(), OPTIONS)

    const [first, second] = handler.mock.calls.map(
      ([request]) => request as OperationRequest & { base: BaseToken },
    )
    expect(first!.base.revision).toBe(3)
    expect(second!.base.revision).toBe(4)
  })

  it("gives up after the configured number of rounds", async () => {
    handler.mockImplementation(() =>
      Promise.resolve({ status: "conflict", snapshot: snapshotOf(validConfig(), 9) }),
    )

    await expect(replaceConfig(validConfig(), OPTIONS)).rejects.toMatchObject({
      name: "ConfigConflictError",
    })
    expect(handler).toHaveBeenCalledTimes(FAST.maxConflictRounds + 1)
  })

  it("does not send a config that does not validate", async () => {
    await expect(replaceConfig(corruptConfig(), OPTIONS)).rejects.toThrow("Config is invalid")

    expect(handler).not.toHaveBeenCalled()
  })

  it("is sent again as a retry when the answer is lost", async () => {
    handler.mockRejectedValueOnce(new Error("lost")).mockResolvedValue(COMMITTED)

    await replaceConfig(validConfig(), OPTIONS)

    expect(handler.mock.calls.map(([request]) => (request as OperationRequest).attempt)).toEqual([
      "first",
      "uncertain-retry",
    ])
  })
})

describe("the operations on backups and kept originals", () => {
  beforeEach(() => {
    handler.mockResolvedValue(COMMITTED)
  })

  it("sends Back up now with the extension version", async () => {
    await backUpNow("1.2.3")

    expect(lastRequest()).toMatchObject({
      kind: "backup-now",
      extensionVersion: "1.2.3",
      attempt: "first",
    })
  })

  it("sends the id of the backup to remove", async () => {
    await removeBackupById("configBackup_1_x")

    expect(lastRequest()).toMatchObject({ kind: "remove-backup", backupId: "configBackup_1_x" })
  })

  it("sends the ids to clear as a fixed list", async () => {
    const ids = ["configBackup_1_a", "configBackup_2_b"]

    await clearBackupsById(ids)

    expect(lastRequest()).toMatchObject({ kind: "clear-backups", backupIds: ids })
  })

  it("sends the key of the kept original to delete", async () => {
    await deletePreservedById("configOriginal_abc")

    expect(lastRequest()).toMatchObject({ kind: "delete-preserved", key: "configOriginal_abc" })
  })

  it.each([
    { name: "Back up now", run: () => backUpNow("0.0.1") },
    { name: "removing a backup", run: () => removeBackupById("configBackup_1_x") },
    { name: "clearing backups", run: () => clearBackupsById(["configBackup_1_x"]) },
    { name: "deleting a kept original", run: () => deletePreservedById("configOriginal_abc") },
  ])("fails with the service's error when $name is not done", async ({ run }) => {
    handler.mockResolvedValue({ status: "refused", reason: "sender-not-allowed" })

    await expect(run()).rejects.toMatchObject({ name: "ConfigRefusedError" })
  })

  it.each([
    { name: "Back up now", run: () => backUpNow("0.0.1") },
    { name: "removing a backup", run: () => removeBackupById("configBackup_1_x") },
    { name: "deleting a kept original", run: () => deletePreservedById("configOriginal_abc") },
  ])("sends $name again as a retry when the answer is lost", async ({ run }) => {
    handler.mockRejectedValueOnce(new Error("lost")).mockResolvedValue(COMMITTED)

    await run()

    const [first, retry] = handler.mock.calls.map(([request]) => request as OperationRequest)
    expect(retry).toEqual({ ...first, attempt: "uncertain-retry" })
  })
})
