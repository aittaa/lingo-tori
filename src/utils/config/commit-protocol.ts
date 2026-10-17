import type { BaseToken, SuspectReason } from "./status"
import type { Config } from "@/types/config/config"
import { defineExtensionMessaging } from "@webext-core/messaging"
import { Sha256Hex } from "@/utils/hash"
import { stableStringify } from "./stable-json"

/**
 * The messages every context other than the background uses to change the config, its meta, the
 * backups and the preserved originals. Reads stay direct; only these writes go to the one service
 * in the background (see `entrypoints/background/config-commit-service.ts`).
 *
 * The messages are plain data and survive JSON as well as structured clone: a browser may drop
 * `undefined` properties on the way, so a writer sends the COMPLETE next config rather than a patch
 * (a field cleared with `undefined` is simply absent in it).
 */

/** "first": the request has not been sent before. "uncertain-retry": it may already have been done. */
export type CommitAttempt = "first" | "uncertain-retry"

interface OperationFields {
  /** Identifies one operation across retries; never reused for another one. */
  opId: string
  /** Digest of the operation's kind and payload; reusing an `opId` with another one is rejected. */
  opDigest: string
  attempt: CommitAttempt
}

export type OperationRequest =
  /** An ordinary edit: the complete next config, computed from the snapshot `base` describes. */
  | (OperationFields & { kind: "edit"; base: BaseToken; next: Config })
  /** Restore, import or reset: an explicit replacement. `backupCurrent` takes an ordinary backup first. */
  | (OperationFields & {
      kind: "replace"
      base: BaseToken
      next: Config
      backupCurrent: boolean
      extensionVersion: string
    })
  | (OperationFields & { kind: "backup-now"; extensionVersion: string })
  | (OperationFields & { kind: "remove-backup"; backupId: string })
  /** The ids are fixed when the request is made; a retry removes exactly those. */
  | (OperationFields & { kind: "clear-backups"; backupIds: string[] })
  | (OperationFields & { kind: "delete-preserved"; key: string })

export type CommitRequest = OperationRequest | { kind: "snapshot" }

export type OperationKind = OperationRequest["kind"]

/** What a reader needs to compute a next config and to say which data it was computed from. */
export interface Snapshot {
  token: BaseToken
  /** The config to compute from: the stored value when usable, the defaults for nothing stored. */
  config: Config | null
  /** Why the stored config cannot be used, when it cannot. */
  unusable?: SuspectReason
}

export type RefusalReason =
  | SuspectReason
  | "base-not-usable"
  | "sender-not-allowed"
  | "operation-not-allowed-for-sender"
  | "field-not-allowed-for-sender"
  | "preservation-failed"
  | "preservation-full"
  | "nothing-to-back-up"

export type CommitResponse =
  | { status: "committed"; token?: BaseToken; backupId?: string }
  /** The data changed since the snapshot; compute again from `snapshot` (definite, nothing was written). */
  | { status: "conflict"; snapshot: Snapshot }
  | { status: "snapshot"; snapshot: Snapshot }
  /** Refused, nothing written. */
  | { status: "refused"; reason: RefusalReason }
  /** Rejected as malformed or inconsistent, nothing written. */
  | { status: "rejected"; reason: "invalid-next" | "op-digest-mismatch" | "malformed-request" }
  /** A retry could not tell whether the first attempt happened. Nothing more is written. */
  | { status: "outcome-unknown" }
  /** The service cannot take operations now (startup failed, storage failed). */
  | { status: "unavailable"; reason: "bootstrap-failed" | "storage-failed" }

interface ProtocolMap {
  lingotoriConfigCommit: (request: CommitRequest) => Promise<CommitResponse>
}

export const { sendMessage: sendCommitMessage, onMessage: onCommitMessage } =
  defineExtensionMessaging<ProtocolMap>()

export const COMMIT_MESSAGE_TYPE = "lingotoriConfigCommit"

/** The digest an operation is identified by: its kind and payload, not its id or attempt. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export function operationDigest(
  request: DistributiveOmit<OperationRequest, "opId" | "opDigest" | "attempt">,
) {
  return Sha256Hex(stableStringify(request))
}

/**
 * In the background itself the service is called directly instead of by message. The background
 * registers its handler here; no other context ever does, so a page, popup or content script
 * always goes through the message path.
 */
type InProcessHandler = (request: CommitRequest) => Promise<CommitResponse>
let inProcessHandler: InProcessHandler | undefined

export function setInProcessCommitHandler(handler: InProcessHandler | undefined) {
  inProcessHandler = handler
}

export function getInProcessCommitHandler() {
  return inProcessHandler
}
