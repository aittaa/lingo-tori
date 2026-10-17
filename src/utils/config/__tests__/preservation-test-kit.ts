// Shared plumbing for the "keep an unusable stored config" tests.
//
// Everything here works on the extension's in-memory browser storage (`fakeBrowser`). The raw
// helpers below read and write the real storage keys (`config`, `config$`, `configOriginal_*`), not
// the code under test, so a test states what is stored without trusting the code that wrote it.
//
// Facts about the fake that the helpers rely on:
//   - `storage.local.get()` returns the stored objects themselves, not copies, so every read here is
//     cloned before a test keeps it;
//   - `null` and `undefined` values are not kept by the fake, so "meta stored as null" cannot be
//     simulated here (a real browser keeps null); absent, `{}` and non-object metas can;
//   - `false`, `0` and `""` are kept and read back as written.

import type { Config } from "@/types/config/config"
import { isDeepStrictEqual } from "node:util"
import { vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { CONFIG_SCHEMA_VERSION } from "@/utils/constants/config"
import { encodeLossless, preservedOriginalKey } from "../preservation"
import { testSeries as v110Series } from "./example/v110"
import { testSeries as v111Series } from "./example/v111"

export const PRIMARY_KEY = "config"
export const META_KEY = "config$"
/** One key per preserved original: `configOriginal_<sha256 of its encoding>`. */
export const PRESERVED_PREFIX = "configOriginal_"
export const BACKUP_LIST_KEY = "backup_ids"
export const MAX_PRESERVED = 5

/** `meta` of a raw primary that has no `config$` key at all. */
export const ABSENT = Symbol("absent")

export interface RawPrimary {
  value: unknown
  /** Whatever is stored under `config$`, or `ABSENT`. */
  meta: unknown
}

export const FIXED_MODIFIED_AT = 1_700_000_000_000
export const CURRENT_META = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  lastModifiedAt: FIXED_MODIFIED_AT,
}

/** A schema-valid current config. The dev-only startup steps (beta flag) have nothing to change. */
export function validConfig(): Config {
  const config = structuredClone(Object.values(v111Series)[0]!.config)
  config.betaExperience.enabled = true
  return config
}

/** The same, with one field of the wrong type: it fails `configSchema` and nothing else is wrong. */
export function corruptConfig(tag = "yes"): any {
  const config: any = validConfig()
  config.contextMenu.enabled = tag
  return config
}

/** A schema-valid config as the previous schema version stored it. */
export function previousVersionConfig(): any {
  const config = structuredClone(Object.values(v110Series)[0]!.config)
  config.betaExperience.enabled = true
  return config
}

export const PREVIOUS_VERSION = CONFIG_SCHEMA_VERSION - 1
export const PREVIOUS_META = { schemaVersion: PREVIOUS_VERSION, lastModifiedAt: FIXED_MODIFIED_AT }

// ----- raw storage -----

/** Where a failed startup keeps its outcome in memory (see `init-failure.ts`); shared by module graphs. */
const INIT_FAILURE_MEMORY = Symbol.for("lingotori.configInitFailure")

export function resetStorage() {
  fakeBrowser.reset()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, INIT_FAILURE_MEMORY)
}

/** Drops only what the background remembers, as a context that never saw the failure would. */
export function forgetWhatTheBackgroundRemembers() {
  Reflect.deleteProperty(globalThis, INIT_FAILURE_MEMORY)
}

/** The `storage.local.set` payload that stores `value` and `meta` as a raw primary. */
export function rawItems(value: unknown, meta: unknown = CURRENT_META) {
  const items: Record<string, unknown> = { [PRIMARY_KEY]: structuredClone(value) }
  if (meta !== ABSENT) items[META_KEY] = structuredClone(meta)
  return items
}

export async function seedPrimary(value: unknown, meta: unknown = CURRENT_META) {
  await fakeBrowser.storage.local.set(rawItems(value, meta))
}

/** A deep copy of everything in `storage.local`, safe to keep across later writes. */
export async function snapshot(): Promise<Record<string, unknown>> {
  return structuredClone(await fakeBrowser.storage.local.get())
}

export async function readRawPrimary(): Promise<RawPrimary> {
  const all = await snapshot()
  return {
    value: Object.hasOwn(all, PRIMARY_KEY) ? all[PRIMARY_KEY] : ABSENT,
    meta: Object.hasOwn(all, META_KEY) ? all[META_KEY] : ABSENT,
  }
}

export function sameRaw(a: RawPrimary, b: RawPrimary) {
  return isDeepStrictEqual(a, b)
}

// ----- the preservation store -----

export interface PreservedEntry {
  v: number
  /** Text encoding of the stored value; for JSON-safe values it is the JSON text itself. */
  encodedValue: string
  /** Same for the stored meta; omitted when the original had no meta key. */
  encodedMeta?: string
  reason: "invalid-schema" | "migration-failed" | "newer-version" | "incoherent"
  capturedAt: number
  extensionVersion: string
}

export function preservedEntries(all: Record<string, unknown>) {
  return Object.entries(all)
    .filter(([key]) => key.startsWith(PRESERVED_PREFIX))
    .map(([key, entry]) => ({ key, entry: entry as PreservedEntry }))
}

export async function readPreserved() {
  return preservedEntries(await snapshot())
}

/**
 * Whether `entry` holds exactly `original`, an absent meta included. The originals the tests use
 * are JSON-safe, so the text encodings are plain JSON and are compared as such, without the
 * product's own decoder.
 */
export function entryHolds(entry: PreservedEntry, original: RawPrimary) {
  if (!entry || typeof entry !== "object" || typeof entry.encodedValue !== "string") return false
  if (!isDeepStrictEqual(JSON.parse(entry.encodedValue), original.value)) return false
  if (original.meta === ABSENT) return !("encodedMeta" in entry)
  return (
    typeof entry.encodedMeta === "string" &&
    isDeepStrictEqual(JSON.parse(entry.encodedMeta), original.meta)
  )
}

export function preservedCopiesOf(all: Record<string, unknown>, original: RawPrimary) {
  return preservedEntries(all).filter(({ entry }) => entryHolds(entry, original))
}

/**
 * The property the user cares about, whichever mechanism provides it: the original is still the
 * stored primary, byte for byte, or an exact copy of it is in the preservation store.
 */
export async function originalIsSafe(original: RawPrimary) {
  const all = await snapshot()
  const primary: RawPrimary = {
    value: Object.hasOwn(all, PRIMARY_KEY) ? all[PRIMARY_KEY] : ABSENT,
    meta: Object.hasOwn(all, META_KEY) ? all[META_KEY] : ABSENT,
  }
  return sameRaw(primary, original) || preservedCopiesOf(all, original).length > 0
}

/** Stores a preserved entry for `original` the way the product does, under its real key. */
export async function seedPreserved(
  original: RawPrimary,
  reason: PreservedEntry["reason"] = "invalid-schema",
) {
  const encodedValue = encodeLossless(original.value)
  const encodedMeta = original.meta === ABSENT ? undefined : encodeLossless(original.meta)
  const key = preservedOriginalKey(encodedValue, encodedMeta)
  const entry: PreservedEntry = {
    v: 1,
    encodedValue,
    ...(encodedMeta === undefined ? {} : { encodedMeta }),
    reason,
    capturedAt: FIXED_MODIFIED_AT,
    extensionVersion: "0.0.1",
  }
  await fakeBrowser.storage.local.set({ [key]: entry })
  return key
}

// ----- ordinary backups, seeded the way `addBackup` stores them -----

let seededBackups = 0

export async function seedBackup(config: unknown, createdAt: number) {
  const id = `configBackup_${createdAt}_seed${seededBackups++}`
  await fakeBrowser.storage.local.set({
    [id]: { schemaVersion: CONFIG_SCHEMA_VERSION, config: structuredClone(config) },
    [`${id}$`]: { createdAt, extensionVersion: "0.0.1" },
  })
  const ids = ((await fakeBrowser.storage.local.get(BACKUP_LIST_KEY))[BACKUP_LIST_KEY] ??
    []) as string[]
  await fakeBrowser.storage.local.set({ [BACKUP_LIST_KEY]: [id, ...ids] })
  return id
}

export function backupEntries(all: Record<string, unknown>) {
  const ids = (all[BACKUP_LIST_KEY] ?? []) as string[]
  return ids.map((id) => ({ id, backup: all[id] as { schemaVersion: number; config: unknown } }))
}

// ----- observing and steering storage calls -----

type Method = "get" | "set" | "remove"

/** The keys a `get`/`set`/`remove` call names (a `get()` with no argument names none). */
export function keysOf(method: Method, args: unknown[]): string[] {
  const first = args[0]
  if (method === "set") return first && typeof first === "object" ? Object.keys(first) : []
  if (typeof first === "string") return [first]
  if (Array.isArray(first)) return first as string[]
  if (first && typeof first === "object") return Object.keys(first)
  return []
}

export function touchesPrimary(keys: string[]) {
  return keys.some((key) => key === PRIMARY_KEY || key === META_KEY)
}

/** Records every `set`/`remove` that names `config` or `config$`, without changing behaviour. */
export function trackPrimaryWrites() {
  const writes: Array<{ method: Method; keys: string[] }> = []
  for (const method of ["set", "remove"] as const) {
    const real = (fakeBrowser.storage.local[method] as (...args: any[]) => Promise<unknown>).bind(
      fakeBrowser.storage.local,
    )
    vi.spyOn(fakeBrowser.storage.local, method as any).mockImplementation(((...args: any[]) => {
      const keys = keysOf(method, args)
      if (touchesPrimary(keys)) writes.push({ method, keys })
      return real(...args)
    }) as any)
  }
  return { writes }
}

/**
 * Holds the first call to `method` that `matches` selects until `release()`, then lets it through.
 * `reached` resolves when the call arrives; every other call goes straight through. `real` is the
 * unwrapped method, for a test's own setup while the gate is armed.
 */
export function holdFirstCall(method: Method, matches: (keys: string[], args: any[]) => boolean) {
  const real = (fakeBrowser.storage.local[method] as (...args: any[]) => Promise<unknown>).bind(
    fakeBrowser.storage.local,
  )
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrive!: () => void
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  let held = false
  vi.spyOn(fakeBrowser.storage.local, method as any).mockImplementation(((...args: any[]) => {
    if (!held && matches(keysOf(method, args), args)) {
      held = true
      arrive()
      return released.then(() => real(...args))
    }
    return real(...args)
  }) as any)
  return { reached, release, real }
}

/**
 * Lets the first call to `get` that `matches` selects run at once, but delays its RESULT until
 * `release()`: a read that started early and answers late, after the stored data has changed.
 * `reached` resolves when that call has been made.
 */
export function holdFirstResult(matches: (keys: string[], args: any[]) => boolean) {
  const real = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
    ...args: any[]
  ) => Promise<unknown>
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrive!: () => void
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  let held = false
  vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation(((...args: any[]) => {
    const result = real(...args)
    if (!held && matches(keysOf("get", args), args)) {
      held = true
      arrive()
      return result.then((value) => released.then(() => value))
    }
    return result
  }) as any)
  return { reached, release }
}

/**
 * Simulates the process dying: from the `crashAt`-th write (1-based, counting `set` and `remove`)
 * onwards every write throws and changes nothing. `writeCalls()` says how many were attempted.
 */
export function crashAtWrite(crashAt: number) {
  let attempted = 0
  for (const method of ["set", "remove"] as const) {
    const real = (fakeBrowser.storage.local[method] as (...args: any[]) => Promise<unknown>).bind(
      fakeBrowser.storage.local,
    )
    vi.spyOn(fakeBrowser.storage.local, method as any).mockImplementation(((...args: any[]) => {
      attempted++
      if (attempted >= crashAt) return Promise.reject(new Error("simulated crash"))
      return real(...args)
    }) as any)
  }
  return { writeCalls: () => attempted }
}

/** Makes every `set` that matches throw, so that "the preservation write failed" can be staged. */
export function failWrites(matches: (keys: string[]) => boolean, times = Infinity) {
  const real = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local) as (
    ...args: any[]
  ) => Promise<unknown>
  let failed = 0
  vi.spyOn(fakeBrowser.storage.local, "set" as any).mockImplementation(((...args: any[]) => {
    if (failed < times && matches(keysOf("set", args))) {
      failed++
      return Promise.reject(new Error("simulated write failure"))
    }
    return real(...args)
  }) as any)
}

/** Lets pending promise chains settle (one macrotask turn is enough for the in-memory storage). */
export async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
