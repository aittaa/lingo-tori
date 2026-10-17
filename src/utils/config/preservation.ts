import type { RawConfigPair, SuspectReason } from "./status"
import { browser } from "#imports"
import { EXTENSION_VERSION } from "@/utils/constants/app"
import { sha256Hex } from "./digest"
import { PreservationError } from "./errors"

/**
 * The preservation store: exact copies of a stored config (value and meta) that could not be used.
 *
 * A copy is never made from a parsed or defaulted value. It is the raw pair as the browser returned
 * it, written in a lossless text encoding, so that an absent key, `null`, `undefined`, `false`, `0`
 * and `""` stay different things and nothing is stripped. Each copy lives under its own key,
 * `configOriginal_<sha256 of the encoding>`, so the same original always lands on the same key and a
 * second capture changes nothing. Ordinary backup rotation never touches these keys.
 *
 * The count is limited to {@link MAX_PRESERVED_ORIGINALS}. Until every writer goes through one queue
 * the count-then-write is not atomic, so the limit is a soft one: concurrent captures of different
 * originals can briefly exceed it. Nothing is ever pruned automatically.
 */
export const PRESERVED_ORIGINAL_PREFIX = "configOriginal_"
export const MAX_PRESERVED_ORIGINALS = 5

const ENTRY_VERSION = 1
const TAG = "$t"

export interface PreservedOriginal {
  v: typeof ENTRY_VERSION
  /** Lossless text encoding of the stored value. */
  encodedValue: string
  /** Lossless text encoding of the stored meta; omitted when no meta key was stored. */
  encodedMeta?: string
  reason: SuspectReason
  /** When the FIRST capture happened; a later capture of the same pair does not change it. */
  capturedAt: number
  extensionVersion: string
}

export type PreserveOutcome = { key: string; outcome: "preserved" | "already-preserved" }

class UnrepresentableValueError extends Error {
  constructor() {
    super("The value cannot be encoded exactly")
    this.name = "UnrepresentableValueError"
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function encodeNode(value: unknown): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value
    case "number":
      if (Number.isNaN(value)) return { [TAG]: "n", v: "NaN" }
      if (value === Infinity) return { [TAG]: "n", v: "Infinity" }
      if (value === -Infinity) return { [TAG]: "n", v: "-Infinity" }
      if (Object.is(value, -0)) return { [TAG]: "n", v: "-0" }
      return value
    case "undefined":
      return { [TAG]: "u" }
    case "bigint":
      return { [TAG]: "i", v: value.toString() }
    case "object": {
      if (value === null) return null
      if (Array.isArray(value)) return Array.from(value, encodeNode)
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new UnrepresentableValueError()
        return { [TAG]: "d", v: value.toISOString() }
      }
      if (!isPlainObject(value)) throw new UnrepresentableValueError()
      // Null prototype: a stored key named "__proto__" must stay an ordinary key.
      const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value).sort()) body[key] = encodeNode(value[key])
      return TAG in body ? { [TAG]: "o", v: body } : body
    }
    default:
      throw new UnrepresentableValueError()
  }
}

function decodeBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new Error("Malformed encoded object")
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, decodeNode(value)]))
}

function decodeNode(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(decodeNode)
  const record = node as Record<string, unknown>
  const tag = record[TAG]
  if (tag === undefined) return decodeBody(record)
  switch (tag) {
    case "u":
      return undefined
    case "n":
      return record.v === "-0" ? -0 : Number(record.v)
    case "i":
      return BigInt(String(record.v))
    case "d":
      return new Date(String(record.v))
    case "o":
      return decodeBody(record.v)
    default:
      throw new Error("Unknown encoding tag")
  }
}

/**
 * Exact text form of a stored value. Objects are written with sorted keys, so two reads of the same
 * data encode identically. Throws when the value holds something storage cannot have produced
 * (a function, a class instance, a Map): such a value is not kept, see {@link preserveOriginal}.
 */
export function encodeLossless(value: unknown): string {
  return JSON.stringify(encodeNode(value))
}

export function decodeLossless(text: string): unknown {
  return decodeNode(JSON.parse(text))
}

/** The key a pair is kept under: the hash covers whether a meta was stored as well as its content. */
export async function preservedOriginalKey(encodedValue: string, encodedMeta?: string) {
  const digest = await sha256Hex(JSON.stringify([encodedValue, encodedMeta ?? null]))
  return `${PRESERVED_ORIGINAL_PREFIX}${digest}`
}

function isPreservedOriginal(entry: unknown): entry is PreservedOriginal {
  if (!isPlainObject(entry)) return false
  return (
    entry.v === ENTRY_VERSION &&
    typeof entry.encodedValue === "string" &&
    (entry.encodedMeta === undefined || typeof entry.encodedMeta === "string") &&
    typeof entry.reason === "string" &&
    typeof entry.capturedAt === "number" &&
    typeof entry.extensionVersion === "string"
  )
}

function samePayload(entry: unknown, encodedValue: string, encodedMeta: string | undefined) {
  return (
    isPreservedOriginal(entry) &&
    entry.encodedValue === encodedValue &&
    entry.encodedMeta === encodedMeta
  )
}

/** Every kept original, oldest first. Reads the whole `storage.local` area; use it rarely. */
export async function listPreservedOriginals() {
  const all = await browser.storage.local.get(null)
  return Object.entries(all)
    .filter(([key]) => key.startsWith(PRESERVED_ORIGINAL_PREFIX))
    .flatMap(([key, entry]) => (isPreservedOriginal(entry) ? [{ key, entry }] : []))
    .sort((a, b) => a.entry.capturedAt - b.entry.capturedAt)
}

/**
 * Keeps an exact copy of a stored pair that is not used, then reads it back and compares it.
 * Resolves only when the copy is confirmed in storage; otherwise throws a {@link PreservationError}
 * and the caller must leave the stored pair alone.
 *
 * - Idempotent: the same pair resolves to the same key. An existing entry is never rewritten, so
 *   its `capturedAt` and `reason` stay those of the first capture.
 * - An entry under the key with a different payload is never overwritten (`verify-failed`).
 * - When {@link MAX_PRESERVED_ORIGINALS} originals are kept and this one is not among them: `full`.
 */
export async function preserveOriginal(
  raw: RawConfigPair,
  reason: SuspectReason,
): Promise<PreserveOutcome> {
  if (!raw.hasValue) throw new Error("There is no stored value to preserve")

  let encodedValue: string
  let encodedMeta: string | undefined
  let key: string
  try {
    encodedValue = encodeLossless(raw.value)
    encodedMeta = raw.hasMeta ? encodeLossless(raw.meta) : undefined
    key = await preservedOriginalKey(encodedValue, encodedMeta)
  } catch (error) {
    if (error instanceof UnrepresentableValueError) {
      throw new PreservationError("unrepresentable", { cause: error })
    }
    throw new PreservationError("write-failed", { cause: error })
  }

  let kept: Record<string, unknown>
  try {
    kept = await browser.storage.local.get(null)
  } catch (error) {
    throw new PreservationError("write-failed", { cause: error })
  }

  if (Object.prototype.hasOwnProperty.call(kept, key)) {
    if (samePayload(kept[key], encodedValue, encodedMeta))
      return { key, outcome: "already-preserved" }
    throw new PreservationError("verify-failed")
  }

  const count = Object.keys(kept).filter((name) =>
    name.startsWith(PRESERVED_ORIGINAL_PREFIX),
  ).length
  if (count >= MAX_PRESERVED_ORIGINALS) throw new PreservationError("full")

  const entry: PreservedOriginal = {
    v: ENTRY_VERSION,
    encodedValue,
    ...(encodedMeta === undefined ? {} : { encodedMeta }),
    reason,
    capturedAt: Date.now(),
    extensionVersion: EXTENSION_VERSION,
  }
  try {
    await browser.storage.local.set({ [key]: entry })
  } catch (error) {
    throw new PreservationError("write-failed", { cause: error })
  }

  let readBack: Record<string, unknown>
  try {
    readBack = await browser.storage.local.get(key)
  } catch (error) {
    throw new PreservationError("verify-failed", { cause: error })
  }
  if (!samePayload(readBack[key], encodedValue, encodedMeta)) {
    throw new PreservationError("verify-failed")
  }
  return { key, outcome: "preserved" }
}
