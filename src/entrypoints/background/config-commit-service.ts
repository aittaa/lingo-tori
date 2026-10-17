import type { Config } from "@/types/config/config"
import type {
  CommitRequest,
  CommitResponse,
  OperationRequest,
  RefusalReason,
  Snapshot,
} from "@/utils/config/commit-protocol"
import type { BaseToken, ConfigStatus, RawConfigPair } from "@/utils/config/status"
import { dequal } from "dequal"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import {
  addBackup,
  backupIdFor,
  clearBackups,
  findBackupMadeBy,
  isSameAsLatestBackup,
  pruneBackups,
  removeBackup,
} from "@/utils/backup/storage"
import {
  COMMIT_MESSAGE_TYPE,
  onCommitMessage,
  setInProcessCommitHandler,
} from "@/utils/config/commit-protocol"
import { PreservationError } from "@/utils/config/errors"
import {
  deletePreservedOriginal,
  pairDigestOf,
  PRESERVED_ORIGINAL_PREFIX,
  preserveOriginal,
} from "@/utils/config/preservation"
import { commitPrimary } from "@/utils/config/primary-write"
import { fingerprintOf, getConfigStatus, readRawConfigPair } from "@/utils/config/status"
import { BACKUP_ID_PREFIX } from "@/utils/constants/backup"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { logger } from "@/utils/logger"
import { getInitializeConfigResult } from "./config"

/**
 * The one place that changes the stored config, its meta, the backups and the preserved originals.
 *
 * WHY ONE PLACE. A browser extension has exactly one background context (the Chrome service worker
 * or the Firefox event page). Neither manifest sets `incognito`, so there is no second, split
 * background (a test reads the manifest source to keep it that way). Every other context - the
 * options page, the popup, content scripts - sends a message here instead of writing, and the
 * first-in first-out queue below turns all of those writes into one sequence. If split incognito
 * were ever enabled this guarantee would no longer hold.
 *
 * WHAT IT DOES NOT CLAIM. The queue lives in memory: it is not a journal, and the worker can be
 * stopped between two steps. What a stop can leave behind is safe by construction - a kept copy
 * next to an unchanged stored config, or a backup entry that was added before the write it
 * belonged to - and the commit itself is one `storage.local.set` call carrying value and meta,
 * confirmed by reading it back. A pair that a browser nevertheless left torn fails its digest and
 * is treated as unusable (and is never repaired by this code). Reads are not queued and stay
 * direct.
 *
 * ORDER OF EVENTS. Startup (`initializeConfig`) is the first job of the queue. Operations that
 * arrive earlier wait for it, so an edit never sees a value that is still being migrated. If
 * startup fails, they are answered with "unavailable" instead of waiting forever.
 */

/** Pages of this extension that may change the settings, and the operations they may ask for. */
const EXTENSION_PAGES = ["/options.html", "/popup.html", "/sidepanel.html"]

type SenderClass = "extension-page" | "content-script" | "internal" | "rejected"

export interface SenderInfo {
  id?: string
  url?: string
  tab?: unknown
}

export interface SenderEnvironment {
  extensionId: string
  /** `browser.runtime.getURL`. */
  getUrl: (path: "/") => string
}

function defaultEnvironment(): SenderEnvironment {
  return { extensionId: browser.runtime.id, getUrl: (path) => browser.runtime.getURL(path) }
}

/**
 * Who is asking. Every message must come from this extension; web pages cannot send one (the
 * manifests have no `externally_connectable`). The settings pages are recognised by their URL, not
 * by anything the sender claims; a message from a tab that is not one of them is a content script.
 */
export function classifySender(
  sender: SenderInfo | undefined,
  environment: SenderEnvironment = defaultEnvironment(),
): SenderClass {
  if (!sender || sender.id !== environment.extensionId) return "rejected"
  if (sender.url) {
    try {
      const actual = new URL(sender.url)
      const own = new URL(environment.getUrl("/"))
      // Extension schemes can have an opaque `origin`, so compare scheme and host directly.
      if (
        actual.protocol === own.protocol &&
        actual.hostname === own.hostname &&
        actual.port === own.port &&
        !actual.username &&
        !actual.password
      ) {
        return EXTENSION_PAGES.includes(actual.pathname) ? "extension-page" : "rejected"
      }
    } catch {
      return "rejected"
    }
  }
  return sender.tab === undefined ? "rejected" : "content-script"
}

/** Content scripts may only change the settings in place, never replace, back up or delete. */
const CONTENT_SCRIPT_KINDS = new Set<CommitRequest["kind"]>(["edit", "snapshot"])

/**
 * A content script's edit may not touch the families that hold credentials, endpoints and the
 * interface language: those are changed from the settings pages. Everything else a page's own
 * controls change (floating button, subtitles, selection toolbar, language, providers per
 * feature, the translation mode) is allowed.
 */
function contentScriptMayChange(current: Config, next: Config) {
  return (
    dequal(current.providersConfig, next.providersConfig) && current.uiLanguage === next.uiLanguage
  )
}

function isBackupId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${BACKUP_ID_PREFIX}_`)
}

function refused(reason: RefusalReason): CommitResponse {
  return { status: "refused", reason }
}

function snapshotOf(status: ConfigStatus, token: BaseToken): Snapshot {
  return {
    token,
    config: status.kind === "usable" ? status.config : null,
    ...(status.kind === "suspect" ? { unusable: status.reason } : {}),
  }
}

/**
 * Once startup has run, a stored config that is still labelled with an older version is one whose
 * migration failed: it is unusable, and is kept as it is. The token is taken from the state as it
 * was read, so it matches the one a reader outside the background computed from the same data.
 */
function afterStartup(status: ConfigStatus): ConfigStatus {
  return status.kind === "upgrading"
    ? { kind: "suspect", raw: status.raw, reason: "migration-failed" }
    : status
}

/**
 * Whether the stored pair is, by a fresh read, exactly `original`: the only case in which a write
 * that failed is known not to have happened. A read that fails says nothing, so it is not "yes".
 */
async function storedPairIsStill(original: RawConfigPair) {
  try {
    return pairDigestOf(await readRawConfigPair()) === pairDigestOf(original)
  } catch {
    return false
  }
}

/**
 * Finishes the rotation that an earlier replacement deferred.
 *
 * A replacement adds the backup of the config it replaces before it commits, and rotates the list
 * only after the commit is confirmed. One whose commit could not be confirmed keeps its backup (see
 * `executePrimary`), which leaves the list one entry above its limit. Every job that may add a
 * backup - a replacement (restore, import or reset alike), Back up now and the hourly backup -
 * first rotates the list down to its limit, newest first, when the primary it has just read is
 * usable and coherent.
 *
 * The rotation REPORTS a failure (it throws), and a job adds its backup only when the list can take
 * one more: because the rotation worked now, or because there was no excess. See
 * {@link roomForOneMoreBackup}. A rotation that keeps failing therefore never lets the list grow: a
 * replacement is refused before it writes anything, Back up now is refused, and the hourly backup
 * is skipped. So between two jobs the list holds at most MAX_BACKUPS_COUNT + 1 entries, however
 * many replacements were left unconfirmed, and the extra entry is the most recent copy taken before
 * a replacement. The only entries the rotation removes are the oldest ones beyond the limit.
 *
 * That is a bound on the count, not on the time: the extra entry stays until a rotation succeeds,
 * and it stays for as long as writes keep failing or nothing else runs. Nothing is rotated while
 * the primary is not usable and coherent (a replacement of such a config keeps a preserved copy
 * instead of a backup, and the other jobs add nothing).
 */
async function finishDeferredRotation(status: ConfigStatus) {
  if (status.kind !== "usable") return
  await pruneBackups()
}

/**
 * Whether a job that is about to add a backup may do so: the list holds at most MAX_BACKUPS_COUNT
 * entries, because the rotation worked now or because there was nothing to rotate. When the
 * rotation fails it is `false` and the job adds nothing. The error is a storage failure; it carries
 * no stored settings.
 */
async function roomForOneMoreBackup(status: ConfigStatus) {
  try {
    await finishDeferredRotation(status)
    return true
  } catch (error) {
    logger.error("Could not rotate the backups, so no backup is added", error)
    return false
  }
}

function sameToken(a: { kind: string; revision: number; valueHash: string }, b: typeof a) {
  return a.kind === b.kind && a.revision === b.revision && a.valueHash === b.valueHash
}

export interface ConfigCommitServiceOptions {
  /** The startup job. It is the first job of the queue; everything else waits for it. */
  bootstrap: () => Promise<unknown>
  now?: () => number
}

export interface ConfigCommitService {
  /** Handles one request from `sender`; resolves, never rejects. */
  handle: (request: CommitRequest, sender: SenderInfo | undefined) => Promise<CommitResponse>
  /** The same for the background's own callers: no admission check, same queue. */
  handleInternal: (request: CommitRequest) => Promise<CommitResponse>
  /**
   * The hourly backup: after startup, inside the queue, backs up the config exactly as stored
   * unless it is not usable or the latest backup already holds it. Resolves with the new backup's
   * id, or undefined when nothing was backed up.
   */
  backUpIfChanged: (extensionVersion: string) => Promise<string | undefined>
}

export function createConfigCommitService(
  options: ConfigCommitServiceOptions,
  environment?: SenderEnvironment,
): ConfigCommitService {
  const now = options.now ?? Date.now
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = queue.then(job, job)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const readiness = enqueue(options.bootstrap).then(
    () => "ready" as const,
    (error: unknown) => {
      logger.error("Config startup failed; changes to the settings are unavailable", error)
      return "failed" as const
    },
  )

  async function currentStatus() {
    // The same reader the writers use, so that the token a writer sends and the one computed here
    // describe the pair in the same terms (a pair a kept copy holds is `suspect`, not `upgrading`).
    const read = await getConfigStatus()
    return { status: afterStartup(read), token: fingerprintOf(read) }
  }

  /**
   * The receipt of the last committed operation: has THIS operation already been committed?
   * Reusing an id for a different operation is rejected.
   */
  function receiptOf(status: ConfigStatus, request: OperationRequest) {
    if (status.kind !== "usable" || status.lastOpId !== request.opId) return "none" as const
    return status.lastOpDigest === request.opDigest ? ("done" as const) : ("mismatch" as const)
  }

  async function executePrimary(
    request: Extract<OperationRequest, { kind: "edit" | "replace" }>,
    senderClass: SenderClass,
  ): Promise<CommitResponse> {
    const { status, token } = await currentStatus()

    const receipt = receiptOf(status, request)
    if (receipt === "mismatch") return { status: "rejected", reason: "op-digest-mismatch" }
    if (receipt === "done") {
      // A replacement found done may have left the rotation it deferred unfinished (its first
      // answer was lost or unconfirmed): finish it now.
      // Nothing is added on this path, so a rotation that fails here is only tried again later.
      if (request.kind === "replace") await finishDeferredRotation(status).catch(() => undefined)
      return { status: "committed", token }
    }

    // The backup a replacement takes first is answered by the operation id like the primary pair
    // is, and under the same rule: an id that comes with another digest is another operation.
    const already = request.kind === "replace" ? await findBackupMadeBy(request.opId) : undefined
    if (already && already.opDigest !== request.opDigest) {
      return { status: "rejected", reason: "op-digest-mismatch" }
    }

    if (request.kind === "edit") {
      // An edit computed from the defaults that stand in for an unusable config is never committed.
      if (request.base.kind !== "usable" && request.base.kind !== "absent") {
        return refused("base-not-usable")
      }
      if (status.kind === "suspect") return refused(status.reason)
    }

    const parsed = configSchema.safeParse(request.next)
    if (!parsed.success) return { status: "rejected", reason: "invalid-next" }

    // The data must be exactly what the request was computed from. A first attempt that finds
    // anything else is a definite conflict (nothing was written, and the writer computes again from
    // the fresh snapshot). A retry that finds anything else cannot know whether its first attempt
    // happened, so it stops.
    if (!sameToken(token, request.base)) {
      return request.attempt === "uncertain-retry"
        ? { status: "outcome-unknown" }
        : { status: "conflict", snapshot: snapshotOf(status, token) }
    }

    if (senderClass === "content-script") {
      const current = status.kind === "usable" ? status.config : DEFAULT_CONFIG
      if (!contentScriptMayChange(current, parsed.data)) {
        return refused("field-not-allowed-for-sender")
      }
    }

    let addedBackupId: string | undefined
    if (request.kind === "replace") {
      if (status.kind === "suspect") {
        // An explicit replacement of an unusable config: keep an exact copy first and confirm it.
        // If that cannot be done, nothing is replaced. An ordinary backup of what the screens show
        // (the defaults) is never taken.
        try {
          await preserveOriginal(status.raw, status.reason)
        } catch (error) {
          logger.error("Could not keep a copy of the stored config; nothing was replaced", error)
          return refused(
            error instanceof PreservationError && error.code === "full"
              ? "preservation-full"
              : "preservation-failed",
          )
        }
      } else if (request.backupCurrent && status.kind === "usable") {
        const stored = status.raw.value as Config
        // A backup is added only while the list can take one more. If it cannot be made to, the
        // replacement is refused here, before the backup and before the primary are written.
        if (!(await roomForOneMoreBackup(status))) {
          return { status: "unavailable", reason: "storage-failed" }
        }
        if (!already && !(await isSameAsLatestBackup(stored, CONFIG_SCHEMA_VERSION))) {
          addedBackupId = await addBackup(stored, request.extensionVersion, CONFIG_SCHEMA_VERSION, {
            backupId: backupIdFor(now(), request.opId),
            opDigest: request.opDigest,
            prune: false,
          })
        }
      }
    }

    try {
      const receiptAfter = await commitPrimary(parsed.data, {
        previous: status.raw,
        opId: request.opId,
        opDigest: request.opDigest,
        lastModifiedAt: now(),
      })
      if (addedBackupId !== undefined) await pruneBackups().catch(() => undefined)
      return {
        status: "committed",
        token: { kind: "usable", ...receiptAfter },
        ...(addedBackupId === undefined ? {} : { backupId: addedBackupId }),
      }
    } catch (error) {
      logger.error("Could not commit the config", error)
      // The backup that was added only for this replacement is taken back when the replacement is
      // known not to have happened, so that one that did not happen leaves the list as it was. The
      // write may have gone through even though the commit could not be confirmed (the read that
      // confirms it failed): then the backup is the only copy of what was replaced and it stays. The
      // rotation it deferred is finished by the next job that may add a backup (see
      // `finishDeferredRotation`), or by this replacement sent again; until then the list is at most
      // one entry above its limit, and no job adds to it while that rotation fails.
      if (addedBackupId !== undefined && (await storedPairIsStill(status.raw))) {
        await removeBackup(addedBackupId).catch(() => undefined)
      }
      return { status: "unavailable", reason: "storage-failed" }
    }
  }

  async function executeBackupNow(
    request: Extract<OperationRequest, { kind: "backup-now" }>,
  ): Promise<CommitResponse> {
    // Already made by this operation: done, whichever attempt this is. The same id with another
    // digest is another operation and is not answered with this one's backup.
    const existing = await findBackupMadeBy(request.opId)
    if (existing) {
      return existing.opDigest === request.opDigest
        ? { status: "committed", backupId: existing.id }
        : { status: "rejected", reason: "op-digest-mismatch" }
    }
    // A retry never makes it again: the first attempt either did it (found above) or the answer
    // cannot be explained.
    if (request.attempt === "uncertain-retry") return { status: "outcome-unknown" }

    const { status } = await currentStatus()
    if (status.kind === "suspect") return refused(status.reason)
    if (status.kind !== "usable") return refused("nothing-to-back-up")
    if (!(await roomForOneMoreBackup(status))) {
      return { status: "unavailable", reason: "storage-failed" }
    }
    const backupId = await addBackup(
      status.raw.value as Config,
      request.extensionVersion,
      CONFIG_SCHEMA_VERSION,
      { backupId: backupIdFor(now(), request.opId), opDigest: request.opDigest },
    )
    return { status: "committed", backupId }
  }

  async function execute(
    request: CommitRequest,
    senderClass: SenderClass,
  ): Promise<CommitResponse> {
    switch (request.kind) {
      case "snapshot": {
        const { status, token } = await currentStatus()
        return { status: "snapshot", snapshot: snapshotOf(status, token) }
      }
      case "edit":
      case "replace":
        return executePrimary(request, senderClass)
      case "backup-now":
        return executeBackupNow(request)
      // The operations below are idempotent by the id or key they name, so they are not answered
      // by looking an operation id up: repeating one removes the same thing, or finds it gone.
      // (Clearing uses the list fixed in the request, never the primary revision or the list now.)
      case "remove-backup":
        await removeBackup(request.backupId)
        return { status: "committed" }
      case "clear-backups":
        await clearBackups(request.backupIds)
        return { status: "committed" }
      case "delete-preserved":
        await deletePreservedOriginal(request.key)
        return { status: "committed" }
      default:
        return { status: "rejected", reason: "malformed-request" }
    }
  }

  function isWellFormed(request: CommitRequest) {
    if (!request || typeof request !== "object" || typeof request.kind !== "string") return false
    if (request.kind === "snapshot") return true
    if (
      typeof request.opId !== "string" ||
      request.opId.length === 0 ||
      typeof request.opDigest !== "string" ||
      (request.attempt !== "first" && request.attempt !== "uncertain-retry")
    ) {
      return false
    }
    // The ids and keys a request names must be those of backups and kept originals: a request can
    // never be used to remove another stored key.
    if (request.kind === "remove-backup") return isBackupId(request.backupId)
    if (request.kind === "clear-backups") {
      return Array.isArray(request.backupIds) && request.backupIds.every(isBackupId)
    }
    if (request.kind === "delete-preserved") {
      return typeof request.key === "string" && request.key.startsWith(PRESERVED_ORIGINAL_PREFIX)
    }
    return true
  }

  async function run(request: CommitRequest, senderClass: SenderClass): Promise<CommitResponse> {
    if (!isWellFormed(request)) return { status: "rejected", reason: "malformed-request" }
    if (senderClass === "content-script" && !CONTENT_SCRIPT_KINDS.has(request.kind)) {
      return refused("operation-not-allowed-for-sender")
    }
    if ((await readiness) === "failed") return { status: "unavailable", reason: "bootstrap-failed" }
    try {
      return await enqueue(() => execute(request, senderClass))
    } catch (error) {
      logger.error("A config operation failed", error)
      return { status: "unavailable", reason: "storage-failed" }
    }
  }

  return {
    handle(request, sender) {
      const senderClass = classifySender(sender, environment)
      if (senderClass === "rejected") return Promise.resolve(refused("sender-not-allowed"))
      return run(request, senderClass)
    },
    handleInternal(request) {
      return run(request, "internal")
    },
    async backUpIfChanged(extensionVersion) {
      if ((await readiness) === "failed") return undefined
      return enqueue(async () => {
        const { status } = await currentStatus()
        if (status.kind !== "usable") return undefined
        // Skipped, like any hourly backup that cannot be made, when the list cannot take one more.
        if (!(await roomForOneMoreBackup(status))) return undefined
        const stored = status.raw.value as Config
        if (await isSameAsLatestBackup(stored, CONFIG_SCHEMA_VERSION)) return undefined
        return addBackup(stored, extensionVersion, CONFIG_SCHEMA_VERSION)
      })
    },
  }
}

let instance: ConfigCommitService | undefined
let detachMessages: (() => void) | undefined

/** The background's service. Created at startup by {@link setUpConfigCommitService}. */
export function getConfigCommitService(): ConfigCommitService {
  // Anything that asks before the background's setup has run (a test) gets a service with no
  // startup job: it answers over whatever is stored, and runs no migration.
  instance ??= createConfigCommitService({ bootstrap: () => Promise.resolve() })
  return instance
}

/** Starts answering messages. Calling it again replaces the earlier listener. */
export function attachConfigCommitMessages(
  service: ConfigCommitService = getConfigCommitService(),
) {
  detachMessages?.()
  detachMessages = onCommitMessage(COMMIT_MESSAGE_TYPE, ({ data, sender }) =>
    service.handle(data, sender),
  )
  return () => {
    detachMessages?.()
    detachMessages = undefined
  }
}

/**
 * Called once, synchronously, in the first turn of the background (like the other message handlers,
 * so that a message that wakes the worker is not dropped). Startup becomes the first job of the
 * queue; the background's own writers call the service directly instead of by message.
 */
export function setUpConfigCommitService() {
  instance = createConfigCommitService({ bootstrap: () => getInitializeConfigResult() })
  setInProcessCommitHandler((request) => instance!.handleInternal(request))
  attachConfigCommitMessages(instance)
  return instance
}
