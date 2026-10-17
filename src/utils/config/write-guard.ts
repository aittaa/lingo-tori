import type { CommitRequest, CommitResponse, OperationRequest, Snapshot } from "./commit-protocol"
import type { Config } from "@/types/config/config"
import { configSchema } from "@/types/config/config"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { DEFAULT_CONFIG } from "../constants/config"
import {
  COMMIT_MESSAGE_TYPE,
  getInProcessCommitHandler,
  operationDigest,
  sendCommitMessage,
} from "./commit-protocol"
import {
  ConfigConflictError,
  ConfigOutcomeUnknownError,
  ConfigRecoveryRequiredError,
  ConfigRefusedError,
  ConfigUnavailableError,
  PreservationError,
} from "./errors"
import { fingerprintOf, getConfigStatus } from "./status"

/**
 * The side of the commit service that every writer calls: `writeConfigGuarded` in spirit. Nothing
 * outside the service writes the config, its meta, the backups or the preserved originals; a writer
 * computes what it wants from a snapshot it read itself, sends it with a description of that
 * snapshot, and the service commits it or says why not:
 *
 * - COMMITTED: done.
 * - CONFLICT: the data changed since the snapshot; nothing was written. The writer computes again,
 *   with the SAME updater, from the fresh snapshot that came with the answer (a few times at most).
 * - REFUSED: the stored config cannot be used, or the sender is not allowed this change.
 * - UNKNOWN: a retry could not tell whether the first attempt happened. It is not repeated.
 *
 * A request whose answer is lost (the worker was stopped, the port closed) is sent again with the
 * SAME operation id and marked as a retry; the service recognises an operation it already committed.
 */
export const commitClient = {
  /** How long one attempt may take before the answer is considered lost. */
  timeoutMs: 15_000,
  /** Waits between attempts after a lost answer; the number of entries is the number of retries. */
  retryDelaysMs: [150, 400, 1000],
  /** How many times a conflict is answered by computing again from the fresh snapshot. */
  maxConflictRounds: 4,
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function timeLimited<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("No answer from the settings service")),
      commitClient.timeoutMs,
    )
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/** In the background the service is called directly; every other context sends a message. */
async function transport(request: CommitRequest): Promise<CommitResponse> {
  const direct = getInProcessCommitHandler()
  if (direct) return direct(request)
  return await sendCommitMessage(COMMIT_MESSAGE_TYPE, request)
}

async function send(request: CommitRequest): Promise<CommitResponse> {
  let outgoing: CommitRequest = request
  let lastError: unknown
  for (let round = 0; round <= commitClient.retryDelaysMs.length; round++) {
    try {
      return await timeLimited(transport(outgoing))
    } catch (error) {
      lastError = error
      const delay = commitClient.retryDelaysMs[round]
      if (delay === undefined) break
      // Whatever the first attempt did, a repeat of it must be recognisable as one.
      if (request.kind !== "snapshot") outgoing = { ...request, attempt: "uncertain-retry" }
      await sleep(delay)
    }
  }
  throw new ConfigUnavailableError({ cause: lastError })
}

type OperationBody = DistributiveOmit<OperationRequest, "opId" | "opDigest" | "attempt">
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function operation(body: OperationBody): OperationRequest {
  return {
    ...body,
    opId: getRandomUUID(),
    opDigest: operationDigest(body),
    attempt: "first",
  }
}

/** The error a writer sees for an answer that is not "committed" (conflict is handled by callers). */
function failureFor(response: CommitResponse): Error {
  switch (response.status) {
    case "refused": {
      const { reason } = response
      if (
        reason === "invalid-schema" ||
        reason === "migration-failed" ||
        reason === "newer-version" ||
        reason === "incoherent"
      ) {
        return new ConfigRecoveryRequiredError(reason)
      }
      if (reason === "preservation-full") return new PreservationError("full")
      if (reason === "preservation-failed") return new PreservationError("write-failed")
      if (reason === "nothing-to-back-up")
        return new Error("There are no saved settings to back up.")
      return new ConfigRefusedError(reason)
    }
    case "rejected":
      return new ConfigRefusedError(response.reason)
    case "outcome-unknown":
      return new ConfigOutcomeUnknownError()
    case "unavailable":
      return new ConfigUnavailableError()
    default:
      return new Error("Unexpected answer from the settings service")
  }
}

/**
 * What a writer computes from. Read directly; only a config that is still being upgraded asks the
 * service, which answers once startup has finished (and says so if the migration failed).
 */
export async function readSnapshot(): Promise<Snapshot> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") {
    return { token: fingerprintOf(status), config: null, unusable: status.reason }
  }
  if (status.kind === "upgrading") {
    const response = await send({ kind: "snapshot" })
    if (response.status !== "snapshot") throw failureFor(response)
    return response.snapshot
  }
  return {
    token: fingerprintOf(status),
    config: status.kind === "usable" ? status.config : null,
  }
}

/**
 * Changes the stored config: `compute` is given the config as it is stored (the defaults when
 * nothing is stored) and returns the complete next config. It is evaluated again, from the fresh
 * snapshot, when the data changed in the meantime. Resolves with the config that was committed.
 */
export async function editConfig(compute: (current: Config) => Config): Promise<Config> {
  let snapshot = await readSnapshot()
  for (let round = 0; round <= commitClient.maxConflictRounds; round++) {
    if (snapshot.unusable) throw new ConfigRecoveryRequiredError(snapshot.unusable)
    const parsed = configSchema.safeParse(compute(snapshot.config ?? DEFAULT_CONFIG))
    if (!parsed.success) throw new Error("Config is invalid")

    const response = await send(
      operation({ kind: "edit", base: snapshot.token, next: parsed.data }),
    )
    if (response.status === "committed") return parsed.data
    if (response.status !== "conflict") throw failureFor(response)
    snapshot = response.snapshot
  }
  throw new ConfigConflictError()
}

/**
 * Replaces the stored config with `next` (restore, import, reset): the explicit actions. With a
 * usable config and `backupCurrent` the service backs it up first; with an unusable one it keeps an
 * exact copy first and confirms it, and replaces nothing if that cannot be done.
 */
export async function replaceConfig(
  next: Config,
  options: { backupCurrent: boolean; extensionVersion: string },
): Promise<void> {
  const parsed = configSchema.safeParse(next)
  if (!parsed.success) throw new Error("Config is invalid")
  for (let round = 0; round <= commitClient.maxConflictRounds; round++) {
    const token = fingerprintOf(await getConfigStatus())
    const response = await send(
      operation({
        kind: "replace",
        base: token,
        next: parsed.data,
        backupCurrent: options.backupCurrent,
        extensionVersion: options.extensionVersion,
      }),
    )
    if (response.status === "committed") return
    if (response.status !== "conflict") throw failureFor(response)
  }
  throw new ConfigConflictError()
}

async function simple(body: OperationBody) {
  const response = await send(operation(body))
  if (response.status !== "committed") throw failureFor(response)
  return response
}

/** "Back up now": a backup of the config exactly as stored. */
export async function backUpNow(extensionVersion: string) {
  await simple({ kind: "backup-now", extensionVersion })
}

export async function removeBackupById(backupId: string) {
  await simple({ kind: "remove-backup", backupId })
}

/** Removes exactly these backups; the list is fixed here, so a repeat never removes a newer one. */
export async function clearBackupsById(backupIds: string[]) {
  await simple({ kind: "clear-backups", backupIds })
}

/** Deletes one kept original; the caller has asked the user to confirm. */
export async function deletePreservedById(key: string) {
  await simple({ kind: "delete-preserved", key })
}
