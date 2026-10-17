import type { Config } from "@/types/config/config"
import { dequal } from "dequal"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_SCHEMA_VERSION, CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../constants/config"
import {
  ConfigExportBlockedError,
  ConfigRecoveryRequiredError,
  ConfigUpgradePendingError,
} from "./errors"

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
 * - `invalid-schema`: the value fails the schema of the version it claims (or has no version).
 * - `migration-failed`: a migration step threw. The reader cannot tell this one; startup reports it.
 * - `newer-version`: the meta names a schema version newer than this build (a downgrade).
 * - `incoherent`: the meta is present but cannot be read as a meta.
 */
export type SuspectReason = "invalid-schema" | "migration-failed" | "newer-version" | "incoherent"

export type ConfigStatus =
  /** Nothing is stored. */
  | { kind: "absent"; raw: RawConfigPair }
  /** Valid for the current schema. `metaMissing`: no label was stored, so the label is assumed. */
  | { kind: "usable"; raw: RawConfigPair; config: Config; metaMissing: boolean }
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
 * writers stored only `lastModifiedAt`); anything that is not an object, or a `schemaVersion` that
 * is not a whole number from 1, cannot be read and is malformed.
 */
function readMetaLabel(raw: RawConfigPair): MetaLabel {
  if (!raw.hasMeta) return { kind: "none" }
  if (!isPlainObject(raw.meta)) return { kind: "malformed" }
  const version = raw.meta.schemaVersion
  if (version === undefined) return { kind: "none" }
  if (typeof version === "number" && Number.isInteger(version) && version >= 1) {
    return { kind: "label", version }
  }
  return { kind: "malformed" }
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
 * 2. a meta that cannot be read: `suspect(incoherent)`;
 * 3. a label newer than this build: `suspect(newer-version)` (a downgrade is never edited or stripped);
 * 4. an older label: `upgrading`;
 * 5. the current label, or no label: `usable` if the value validates, else `suspect(invalid-schema)`.
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
  if (label.kind === "label" && label.version < CONFIG_SCHEMA_VERSION) {
    return { kind: "upgrading", raw, fromVersion: label.version }
  }

  const parsed = configSchema.safeParse(raw.value)
  if (!parsed.success) return { kind: "suspect", raw, reason: "invalid-schema" }
  return { kind: "usable", raw, config: parsed.data, metaMissing: label.kind === "none" }
}

export async function getConfigStatus(): Promise<ConfigStatus> {
  return classifyConfigPair(await readRawConfigPair())
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
 * Blocks "export my current settings" while the stored config is suspect: the settings screens show
 * the defaults then, and a file of defaults must never be handed over as the user's settings.
 */
export async function assertCurrentConfigExportable(): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") throw new ConfigExportBlockedError(status.reason)
}

/**
 * Refuses a change to the config unless it is safe to make one: nothing stored yet, or a stored
 * config that is usable. A config that cannot be used is never replaced by defaults plus an edit,
 * and a config that is still being upgraded is never given current-shaped data under its old label.
 * Reading the status failing refuses too (fail closed).
 *
 * This is a plain check before the write, not a lock: another context can still change the stored
 * pair between the check and the write. The writers that use it take the check once, immediately
 * before they read what they will change.
 */
export async function assertConfigWritable(): Promise<void> {
  const status = await getConfigStatus()
  if (status.kind === "suspect") throw new ConfigRecoveryRequiredError(status.reason)
  if (status.kind === "upgrading") throw new ConfigUpgradePendingError()
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
 * read again through the status reader, so a callback never sees a half-written or unvalidated
 * payload, and the last read wins when several are in flight.
 *
 * Nothing is delivered for the state at subscription time; read it with `getConfigView`.
 */
export function watchConfigStatus(callback: (view: ConfigView) => void): () => void {
  let active = true
  let generation = 0
  let last: ConfigView | undefined

  const onChanged = (changes: Record<string, unknown>, area: string) => {
    if (area !== "local") return
    if (!(CONFIG_STORAGE_KEY in changes) && !(CONFIG_META_STORAGE_KEY in changes)) return
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
