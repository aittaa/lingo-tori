import type { RawConfigPair } from "./status"
import type { Config } from "@/types/config/config"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_SCHEMA_VERSION, CONFIG_STORAGE_KEY } from "../constants/config"
import {
  CONFIG_META_STORAGE_KEY,
  classifyConfigPair,
  digestOfStoredValue,
  readRawConfigPair,
  readReceipt,
} from "./status"

/**
 * The meta every commit leaves next to the value. It replaces the old meta; nothing is merged.
 *
 * - `revision` goes up by one with every commit, so a writer can tell that the data changed.
 * - `lastOpId` / `lastOpDigest` name the last operation committed, so that a request retried after
 *   a lost response is recognised as done instead of being applied twice.
 * - `valueDigest` ties the meta to the value it was written with; a pair whose digest does not
 *   match the value is read as incoherent and is never trusted, repaired or migrated.
 */
export interface PrimaryMeta {
  schemaVersion: number
  lastModifiedAt: number
  revision: number
  lastOpId: string
  lastOpDigest: string
  valueDigest: string
}

export interface CommitContext {
  /** The raw pair the commit replaces; its revision is the one the new revision follows. */
  previous: RawConfigPair
  opId: string
  opDigest: string
  /** Kept across a commit that does not change the user's data (the label-only commit). */
  lastModifiedAt?: number
}

export interface CommitReceipt {
  revision: number
  valueHash: string
}

/** The pair was written but could not be read back as it was meant to be stored. */
export class CommitVerificationError extends Error {
  constructor() {
    super("The settings were written but could not be confirmed when read back.")
    this.name = "CommitVerificationError"
  }
}

function buildMeta(context: CommitContext, valueDigest: string): PrimaryMeta {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    lastModifiedAt: context.lastModifiedAt ?? Date.now(),
    revision: readReceipt(context.previous).revision + 1,
    lastOpId: context.opId,
    lastOpDigest: context.opDigest,
    valueDigest,
  }
}

/** Reads the pair back and requires it to be exactly what was meant to be committed. */
async function confirm(meta: PrimaryMeta): Promise<CommitReceipt> {
  const status = classifyConfigPair(await readRawConfigPair())
  if (
    status.kind !== "usable" ||
    status.valueDigest !== meta.valueDigest ||
    status.lastOpId !== meta.lastOpId ||
    status.revision !== meta.revision
  ) {
    throw new CommitVerificationError()
  }
  return { revision: meta.revision, valueHash: meta.valueDigest }
}

/**
 * Commits a valid config and its complete meta in ONE `storage.local.set` call carrying both keys,
 * then reads the pair back and confirms it. That narrows the window in which a restart can see a
 * value with a stale label; it does not claim the browser makes the write atomic - a pair that is
 * torn natively is caught by its digest and treated as unusable.
 *
 * A config that does not validate is refused here, so the stored pair never becomes invalid by this
 * function.
 */
export async function commitPrimary(
  config: Config,
  context: CommitContext,
): Promise<CommitReceipt> {
  if (!configSchema.safeParse(config).success) throw new Error("Config is invalid")
  const meta = buildMeta(context, digestOfStoredValue(config))
  await browser.storage.local.set({
    [CONFIG_STORAGE_KEY]: config,
    [CONFIG_META_STORAGE_KEY]: meta,
  })
  return confirm(meta)
}

/**
 * Commits only the meta, for a stored value that is valid but carries no usable label or time
 * (a config written before revisions and digests existed): the value is not touched, and the meta
 * gains the digest of the value as it is stored.
 */
export async function commitPrimaryMeta(context: CommitContext): Promise<CommitReceipt> {
  const meta = buildMeta(context, digestOfStoredValue(context.previous.value))
  await browser.storage.local.set({ [CONFIG_META_STORAGE_KEY]: meta })
  return confirm(meta)
}
