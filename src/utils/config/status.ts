import type { Config } from "@/types/config/config"
import { dequal } from "dequal"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import { Sha256Hex } from "@/utils/hash"
import { CONFIG_SCHEMA_VERSION, CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../constants/config"
import { ConfigExportBlockedError } from "./errors"
import { findKeptReason, PRESERVED_ORIGINAL_PREFIX } from "./preservation"
import { stableStringify } from "./stable-json"

/** Where the meta of the config lives (WXT keeps a value's meta next to it under `<key>$`). */
export const CONFIG_META_STORAGE_KEY = `${CONFIG_STORAGE_KEY}$`

/**
 * The two stored keys, exactly as the browser returned them. Nothing in here is validated, parsed
 * or defaulted: `hasValue` and `hasMeta` tell a missing key from a stored falsy value, which a
 * default-filling reader cannot.
 */
export interface RawConfigPair {
  value: unknown
  hasValue: boolean
  meta: unknown
  hasMeta: boolean
}

/**
 * Why a stored config is not used.
 *
 * - `invalid-schema`: the value fails the schema of the version it claims (or has no version), or
 *   it was upgraded and the upgraded value still fails.
 * - `migration-failed`: a migration step threw. Only startup can tell; the reader learns it from the
 *   kept copy startup leaves (see {@link getConfigStatus}).
 * - `newer-version`: the meta names a schema version newer than this build (a downgrade).
 * - `incoherent`: the meta is present but cannot be read as a meta: it is not an object, its
 *   `schemaVersion` is not a whole number from 1, or its `lastModifiedAt` is present and is not a
 *   finite number.
 */
export type SuspectReason = "invalid-schema" | "migration-failed" | "newer-version" | "incoherent"

export type ConfigStatus =
  /** Nothing is stored. */
  | { kind: "absent"; raw: RawConfigPair }
  /** Valid for the current schema. `metaMissing`: no label was stored, so the label is assumed. */
  | {
      kind: "usable"
      raw: RawConfigPair
      config: Config
      metaMissing: boolean
      /** Whole number from the meta (0 for a meta written before revisions existed). */
      revision: number
      /** The digest the meta carries for the value, already checked against the value. */
      valueDigest?: string
      lastOpId?: string
      lastOpDigest?: string
    }
  /** Labelled with an older schema version. Startup migrates it before anything else may write. */
  | { kind: "upgrading"; raw: RawConfigPair; fromVersion: number }
  /** Not used, not repaired. The stored pair is an original that must be kept as it is. */
  | { kind: "suspect"; raw: RawConfigPair; reason: SuspectReason }

/** What a session runs on: the parsed value when usable, the defaults (in memory only) otherwise. */
export interface ConfigView {
  config: Config | null
  status: ConfigStatus
}

type MetaLabel = { kind: "none" } | { kind: "label"; version: number } | { kind: "malformed" }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Reads the label out of a raw meta. A meta without a `schemaVersion` carries no label (older
 * writers stored only `lastModifiedAt`); anything that is not an object, a `schemaVersion` that is
 * not a whole number from 1, or a receipt field of the wrong type (`revision`, `valueDigest`,
 * `lastOpId`, `lastOpDigest`) cannot be read and is malformed.
 *
 * A label newer than this build is recognised before the rest of the meta is judged: a newer build
 * may write its receipt differently, and such a pair is `newer-version`, not unreadable.
 */
function readMetaLabel(raw: RawConfigPair): MetaLabel {
  if (!raw.hasMeta) return { kind: "none" }
  if (!isPlainObject(raw.meta)) return { kind: "malformed" }
  const meta = raw.meta
  const version = meta.schemaVersion
  if (version !== undefined && !isWholeNumber(version, 1)) return { kind: "malformed" }
  if (version !== undefined && version > CONFIG_SCHEMA_VERSION) return { kind: "label", version }
  if (meta.revision !== undefined && !isWholeNumber(meta.revision, 0)) return { kind: "malformed" }
  for (const field of ["valueDigest", "lastOpId", "lastOpDigest"]) {
    if (meta[field] !== undefined && typeof meta[field] !== "string") return { kind: "malformed" }
  }
  return version === undefined ? { kind: "none" } : { kind: "label", version }
}

function isWholeNumber(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum
}

/** The digest of a stored value: sorted keys, `undefined` dropped, as storage keeps the data. */
export function digestOfStoredValue(value: unknown): string {
  return Sha256Hex(stableStringify(value))
}

export interface MetaReceipt {
  revision: number
  valueDigest?: string
  lastOpId?: string
  lastOpDigest?: string
}

/** The commit receipt in a raw meta; the meta must already have passed `readMetaLabel`. */
export function readReceipt(raw: RawConfigPair): MetaReceipt {
  if (!raw.hasMeta || !isPlainObject(raw.meta)) return { revision: 0 }
  const meta = raw.meta
  return {
    revision: typeof meta.revision === "number" ? meta.revision : 0,
    valueDigest: typeof meta.valueDigest === "string" ? meta.valueDigest : undefined,
    lastOpId: typeof meta.lastOpId === "string" ? meta.lastOpId : undefined,
    lastOpDigest: typeof meta.lastOpDigest === "string" ? meta.lastOpDigest : undefined,
  }
}

/**
 * A `lastModifiedAt` that is present and is not a finite number. A MISSING one is an older
 * writer's meta and is completed; a malformed one is data nobody should overwrite unread.
 */
function hasMalformedModifiedAt(raw: RawConfigPair): boolean {
  if (!raw.hasMeta || !isPlainObject(raw.meta)) return false
  const value = raw.meta.lastModifiedAt
  return value !== undefined && !(typeof value === "number" && Number.isFinite(value))
}

/** `lastModifiedAt` of a raw meta when it is a usable time, so a rewrite can keep it. */
export function readModifiedAt(raw: RawConfigPair): number | undefined {
  if (!raw.hasMeta || !isPlainObject(raw.meta)) return undefined
  const value = raw.meta.lastModifiedAt
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Reads `config` and `config$` in ONE `storage.local.get` call, so the pair is read together.
 * A value stored as `null` counts as not stored (that is what removing a key through WXT leaves).
 */
export async function readRawConfigPair(): Promise<RawConfigPair> {
  const items = await browser.storage.local.get([CONFIG_STORAGE_KEY, CONFIG_META_STORAGE_KEY])
  const value: unknown = items[CONFIG_STORAGE_KEY]
  const meta: unknown = items[CONFIG_META_STORAGE_KEY]
  return {
    value,
    hasValue: value !== undefined && value !== null,
    meta,
    hasMeta:
      Object.prototype.hasOwnProperty.call(items, CONFIG_META_STORAGE_KEY) && meta !== undefined,
  }
}

/**
 * Classifies a stored pair without running a migration (this module is loaded by content scripts,
 * which must not carry the migration scripts):
 *
 * 1. no value: `absent`;
 * 2. a meta that cannot be read (its version label or a receipt field): `suspect(incoherent)`;
 * 3. a label newer than this build: `suspect(newer-version)` (a downgrade is never edited or stripped),
 *    whatever else the meta holds;
 * 4. a meta whose value digest does not match the stored value, or a `lastModifiedAt` that is
 *    present and is not a finite number: `suspect(incoherent)`;
 * 5. an older label: `upgrading`;
 * 6. the current label, or no label: `usable` if the value validates, else `suspect(invalid-schema)`.
 *
 * Falsy values (`false`, `0`, `""`) and non-objects are values like any other: they fail the schema
 * and are suspect. They are never read as "nothing stored".
 */
export function classifyConfigPair(raw: RawConfigPair): ConfigStatus {
  if (!raw.hasValue) return { kind: "absent", raw }

  const label = readMetaLabel(raw)
  if (label.kind === "malformed") return { kind: "suspect", raw, reason: "incoherent" }
  if (label.kind === "label" && label.version > CONFIG_SCHEMA_VERSION) {
    return { kind: "suspect", raw, reason: "newer-version" }
  }
  const receipt = readReceipt(raw)
  // A meta that says which value it was committed with must agree with the value that is stored:
  // a pair that does not was torn (or edited) and is not trusted, repaired or migrated.
  if (receipt.valueDigest !== undefined && receipt.valueDigest !== digestOfStoredValue(raw.value)) {
    return { kind: "suspect", raw, reason: "incoherent" }
  }
  if (hasMalformedModifiedAt(raw)) return { kind: "suspect", raw, reason: "incoherent" }
  if (label.kind === "label" && label.version < CONFIG_SCHEMA_VERSION) {
    return { kind: "upgrading", raw, fromVersion: label.version }
  }

  const parsed = configSchema.safeParse(raw.value)
  if (!parsed.success) return { kind: "suspect", raw, reason: "invalid-schema" }
  return {
    kind: "usable",
    raw,
    config: parsed.data,
    metaMissing: label.kind === "none",
    ...receipt,
  }
}

/**
 * What a writer's decision was based on: the kind of state, the revision from the meta (0 for a
 * meta that predates revisions) and a digest of the data. A usable value is hashed on its own; for
 * every other state the digest covers the value and the meta together. If the stored data changes
 * in any way between the snapshot and the commit, the token no longer matches.
 */
export interface BaseToken {
  kind: ConfigStatus["kind"]
  revision: number
  valueHash: string
}

export function fingerprintOf(status: ConfigStatus): BaseToken {
  const revision = readReceipt(status.raw).revision
  if (status.kind === "absent") return { kind: "absent", revision, valueHash: "absent" }
  if (status.kind === "usable") {
    return {
      kind: "usable",
      revision,
      valueHash: status.valueDigest ?? digestOfStoredValue(status.raw.value),
    }
  }
  const pair = { value: status.raw.value, meta: status.raw.hasMeta ? status.raw.meta : null }
  return { kind: status.kind, revision, valueHash: Sha256Hex(stableStringify(pair)) }
}

/**
 * The status of what is stored right now. A pair with an older label is `upgrading` until startup
 * has run; when startup could not upgrade it, it leaves the pair as it is, label included, and keeps
 * an exact copy. That copy is what tells "cannot be upgraded" from "not upgraded yet": a pair that a
 * kept copy holds is `suspect` with the reason startup recorded, so a failed upgrade is never
 * described as a pending one. (Startup itself classifies the pair without this lookup, and so tries
 * the upgrade again on every start.)
 */
export async function getConfigStatus(): Promise<ConfigStatus> {
  const raw = await readRawConfigPair()
  const status = classifyConfigPair(raw)
  if (status.kind !== "upgrading") return status
  const reason = await findKeptReason(raw)
  return reason ? { kind: "suspect", raw, reason } : status
}

/**
 * The session's view of a status. Only a usable value is used as stored; a value that is still
 * being upgraded is used if it already validates (as the reader always did, so a page opened before
 * startup finishes keeps working); everything else runs on the defaults, in memory only.
 */
export function viewOfStatus(status: ConfigStatus): ConfigView {
  if (status.kind === "absent") return { config: null, status }
  if (status.kind === "usable") return { config: status.config, status }
  if (status.kind === "upgrading") {
    const parsed = configSchema.safeParse(status.raw.value)
    return { config: parsed.success ? parsed.data : DEFAULT_CONFIG, status }
  }
  return { config: DEFAULT_CONFIG, status }
}

export async function getConfigView(): Promise<ConfigView> {
  return viewOfStatus(await getConfigStatus())
}

/**
 * Blocks "export my current settings" while the stored config is suspect or has not been upgraded:
 * the settings screens show the defaults (or a value of an older shape) then, and a file of those
 * must never be handed over as the user's settings. The recovery export hands over the stored data
 * exactly as it is.
 */
export async function assertCurrentConfigExportable(): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") throw new ConfigExportBlockedError(status.reason)
  // A config still labelled with an older version that has not been migrated is shown as the
  // defaults when it does not validate, so it is not exported either.
  if (status.kind === "upgrading") throw new ConfigExportBlockedError("upgrading")
}

function sameView(a: ConfigView, b: ConfigView) {
  if (a.status.kind !== b.status.kind) return false
  if (a.status.kind === "suspect" && b.status.kind === "suspect") {
    if (a.status.reason !== b.status.reason) return false
  }
  return dequal(a.config, b.config)
}

/**
 * Calls `callback` with the session view whenever the stored config or its meta changes and the
 * view differs from the last one delivered. A notification is only an invalidation: the pair is
 * read again, in one call, through the status reader, so a callback gets a validated view and never
 * the payload the notification carried, and the last read wins when several are in flight. This
 * does not detect a pair whose value and meta were written apart; nothing here can tell.
 *
 * Nothing is delivered for the state at subscription time; read it with `getConfigView`.
 */
export function watchConfigStatus(callback: (view: ConfigView) => void): () => void {
  let active = true
  let generation = 0
  let last: ConfigView | undefined

  const onChanged = (changes: Record<string, unknown>, area: string) => {
    if (area !== "local") return
    // A kept copy appearing can change what an older-labelled pair is (see getConfigStatus).
    const relevant =
      CONFIG_STORAGE_KEY in changes ||
      CONFIG_META_STORAGE_KEY in changes ||
      Object.keys(changes).some((key) => key.startsWith(PRESERVED_ORIGINAL_PREFIX))
    if (!relevant) return
    const mine = ++generation
    void getConfigView().then(
      (view) => {
        if (!active || mine !== generation) return
        if (last && sameView(last, view)) return
        last = view
        callback(view)
      },
      () => {
        // A later notification reads again.
      },
    )
  }

  // Remember what is stored now, so the first change is compared with it and not delivered blindly.
  void getConfigView().then(
    (view) => {
      if (active && last === undefined) last = view
    },
    () => {},
  )

  browser.storage.onChanged.addListener(onChanged)
  return () => {
    active = false
    browser.storage.onChanged.removeListener(onChanged)
  }
}
