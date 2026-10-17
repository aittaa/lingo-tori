import type { RawConfigPair, SuspectReason } from "./status"
import { browser } from "#imports"
import { logger } from "../logger"
import { findKeptReason, pairDigestOf } from "./preservation"

/**
 * The outcome of a startup that could not upgrade the stored config, kept for the exact pair it
 * was about.
 *
 * Startup leaves such a pair as it is, label included, and tries to keep an exact copy of it. A
 * kept copy is what tells "could not be upgraded" from "not upgraded yet" to every reader (see
 * `getConfigStatus`). The copy can fail to exist: the store of copies can be full, and storage can
 * refuse the write. A completed failed upgrade must not be reported as a retryable one in those
 * cases either, so the outcome is also remembered here, independently of the copy:
 *
 * - in storage, as one small marker under {@link INIT_FAILURE_KEY}, written best effort and naming
 *   the pair by its digest and the reason; and
 * - in the memory of the context that ran startup (the background), whether or not the marker
 *   could be written.
 *
 * A marker applies only to the pair whose digest it names: when the stored pair changes it simply
 * stops matching, and a later start that upgrades the pair, or starts over a pair that is not
 * upgrading, removes it. There is at most one marker.
 *
 * Honest limit: when even the marker cannot be written, only the background knows. Another context
 * (the settings page, the popup) can still read the pair as "upgrading"; every action that would
 * replace, back up or export it refuses for that status too.
 */
export const INIT_FAILURE_KEY = "configInitFailure"

export type InitFailureReason = Extract<SuspectReason, "migration-failed" | "invalid-schema">

interface InitFailure {
  digest: string
  reason: InitFailureReason
}

/** The background's memory: on `globalThis`, so that every module graph of one context shares it. */
const MEMORY = Symbol.for("lingotori.configInitFailure")

type Memory = { [MEMORY]?: InitFailure }

function memory(): Memory {
  return globalThis as unknown as Memory
}

function isInitFailureReason(value: unknown): value is InitFailureReason {
  return value === "migration-failed" || value === "invalid-schema"
}

function readMarker(value: unknown): InitFailure | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const marker = value as { v?: unknown; digest?: unknown; reason?: unknown }
  if (marker.v !== 1 || typeof marker.digest !== "string" || !isInitFailureReason(marker.reason)) {
    return undefined
  }
  return { digest: marker.digest, reason: marker.reason }
}

/**
 * Remembers that startup finished without upgrading `raw`: in memory first, then in storage. Never
 * throws; a marker that cannot be written is logged and only the memory holds the outcome.
 */
export async function recordInitFailure(raw: RawConfigPair, reason: InitFailureReason) {
  let digest: string
  try {
    digest = pairDigestOf(raw)
  } catch {
    return
  }
  memory()[MEMORY] = { digest, reason }
  try {
    await browser.storage.local.set({
      [INIT_FAILURE_KEY]: { v: 1, digest, reason, at: Date.now() },
    })
  } catch (error) {
    logger.error("Could not record that the config upgrade failed; only this context knows", error)
  }
}

/** Forgets the outcome of an earlier failed start: the upgrade worked, or there is nothing to upgrade. */
export async function clearInitFailure() {
  Reflect.deleteProperty(memory(), MEMORY)
  try {
    // Written only when there is something to remove: an ordinary start writes nothing here.
    if ((await browser.storage.local.get(INIT_FAILURE_KEY))[INIT_FAILURE_KEY] !== undefined) {
      await browser.storage.local.remove(INIT_FAILURE_KEY)
    }
  } catch (error) {
    logger.error("Could not remove the record of a failed config upgrade", error)
  }
}

/**
 * Why a pair that has an older label is not going to be upgraded by a retry: the reason of a kept
 * copy of exactly this pair, else the reason startup recorded for exactly this pair (in this
 * context's memory, else in storage). `undefined` when nothing says the upgrade has failed.
 */
export async function findFailedUpgradeReason(
  raw: RawConfigPair,
): Promise<SuspectReason | undefined> {
  const kept = await findKeptReason(raw)
  if (kept) return kept

  let digest: string
  try {
    digest = pairDigestOf(raw)
  } catch {
    return undefined
  }
  const remembered = memory()[MEMORY]
  if (remembered?.digest === digest) return remembered.reason
  try {
    const stored = readMarker((await browser.storage.local.get(INIT_FAILURE_KEY))[INIT_FAILURE_KEY])
    return stored?.digest === digest ? stored.reason : undefined
  } catch {
    return undefined
  }
}
