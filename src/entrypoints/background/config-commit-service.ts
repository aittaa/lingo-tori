import type { Config } from "@/types/config/config"
import type {
  CommitRequest,
  CommitResponse,
  OperationRequest,
  RefusalReason,
  Snapshot,
} from "@/utils/config/commit-protocol"
import type { BaseToken, ConfigStatus } from "@/utils/config/status"
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
  PRESERVED_ORIGINAL_PREFIX,
  preserveOriginal,
} from "@/utils/config/preservation"
import { commitPrimary } from "@/utils/config/primary-write"
import { classifyConfigPair, fingerprintOf, readRawConfigPair } from "@/utils/config/status"
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
    const read = classifyConfigPair(await readRawConfigPair())
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
    if (receipt === "done") return { status: "committed", token }

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
        const already = await findBackupMadeBy(request.opId)
        if (!already && !(await isSameAsLatestBackup(stored, CONFIG_SCHEMA_VERSION))) {
          addedBackupId = await addBackup(stored, request.extensionVersion, CONFIG_SCHEMA_VERSION, {
            backupId: backupIdFor(now(), request.opId),
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
      // The backup that was added only for this replacement is taken back, so a replacement that
      // did not happen leaves the list as it was.
      if (addedBackupId !== undefined) await removeBackup(addedBackupId).catch(() => undefined)
      return { status: "unavailable", reason: "storage-failed" }
    }
  }

  async function executeBackupNow(
    request: Extract<OperationRequest, { kind: "backup-now" }>,
  ): Promise<CommitResponse> {
    // Already made by this operation: done, whichever attempt this is.
    const existing = await findBackupMadeBy(request.opId)
    if (existing) return { status: "committed", backupId: existing }
    // A retry never makes it again: the first attempt either did it (found above) or the answer
    // cannot be explained.
    if (request.attempt === "uncertain-retry") return { status: "outcome-unknown" }

    const { status } = await currentStatus()
    if (status.kind === "suspect") return refused(status.reason)
    if (status.kind !== "usable") return refused("nothing-to-back-up")
    const backupId = await addBackup(
      status.raw.value as Config,
      request.extensionVersion,
      CONFIG_SCHEMA_VERSION,
      { backupId: backupIdFor(now(), request.opId) },
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
