import type { SuspectReason } from "./status"
import { kebabCase } from "case-anything"
import { APP_NAME, EXTENSION_VERSION } from "@/utils/constants/app"
import { KeptCopyRestoreError } from "./errors"
import { encodeLossless, listPreservedOriginals } from "./preservation"
import { readRawConfigPair } from "./status"

/**
 * The recovery export: a way to get the user's stored settings out of the extension EXACTLY as they
 * are, when the extension itself cannot use them. It reads and never writes.
 *
 * Unlike the ordinary export it does not go through the settings screens (which show the defaults
 * for a config that cannot be used) and it does not remove credentials: the point is a faithful
 * copy, so the file holds API keys and other secrets in plain text, and every place that offers it
 * says so before it is saved. Nothing here puts a stored value on a screen; the summaries below carry
 * no values, and the file goes straight to the download.
 *
 * Two sources:
 * - a kept copy (see `preservation.ts`), which is what startup saved when it could not use the config;
 * - the stored pair as found right now, for the case where no kept copy could be made (the store of
 *   copies is full or storage refused the write).
 *
 * Both files hold the text encoding of the raw value and of the raw meta, as `preservation.ts`
 * writes it, so nothing the browser stored is lost, and `decodeLossless` turns it back.
 */
export const RECOVERY_EXPORT_FORMAT = "lingotori-config-recovery"
export const RECOVERY_EXPORT_VERSION = 1

export type RecoveryExportSource = "kept-copy" | "stored-as-found"

export interface RecoveryExportFile {
  format: typeof RECOVERY_EXPORT_FORMAT
  formatVersion: typeof RECOVERY_EXPORT_VERSION
  source: RecoveryExportSource
  /** Why the config was not used; only a kept copy carries it. */
  reason?: SuspectReason
  /** When the kept copy was first made; only a kept copy carries it. */
  capturedAt?: number
  /** The extension version that kept the copy (a kept copy), or that wrote this file. */
  extensionVersion: string
  exportedAt: number
  /** Lossless text encoding of the stored value. */
  encodedValue: string
  /** Lossless text encoding of the stored meta; absent when no meta was stored. */
  encodedMeta?: string
}

export interface KeptCopySummary {
  key: string
  reason: SuspectReason
  capturedAt: number
  extensionVersion: string
}

export interface RecoveryDownload {
  fileName: string
  json: string
}

/** What is kept, oldest first, without any stored value. */
export async function listKeptCopies(): Promise<KeptCopySummary[]> {
  return (await listPreservedOriginals()).map(({ key, entry }) => ({
    key,
    reason: entry.reason,
    capturedAt: entry.capturedAt,
    extensionVersion: entry.extensionVersion,
  }))
}

function stamp(time: number) {
  return new Date(time).toISOString().replaceAll(/[:.]/g, "-")
}

function fileNameFor(kind: "kept" | "found", time: number) {
  const base = kebabCase(APP_NAME)
  return kind === "kept"
    ? `${base}-unreadable-settings-${stamp(time)}.json`
    : `${base}-stored-settings-as-found-${stamp(time)}.json`
}

/** The exact file for one kept copy. Fails if that copy is gone. */
export async function buildKeptCopyExport(key: string): Promise<RecoveryDownload> {
  const found = (await listPreservedOriginals()).find((item) => item.key === key)
  if (!found) throw new KeptCopyRestoreError("gone")
  const { entry } = found
  const file: RecoveryExportFile = {
    format: RECOVERY_EXPORT_FORMAT,
    formatVersion: RECOVERY_EXPORT_VERSION,
    source: "kept-copy",
    reason: entry.reason,
    capturedAt: entry.capturedAt,
    extensionVersion: entry.extensionVersion,
    exportedAt: Date.now(),
    encodedValue: entry.encodedValue,
    ...(entry.encodedMeta === undefined ? {} : { encodedMeta: entry.encodedMeta }),
  }
  return { fileName: fileNameFor("kept", entry.capturedAt), json: JSON.stringify(file, null, 2) }
}

/** The stored pair, read now and encoded as it is. Works when no kept copy could be made. */
export async function buildStoredAsFoundExport(): Promise<RecoveryDownload> {
  const raw = await readRawConfigPair()
  if (!raw.hasValue) throw new Error("There are no stored settings, so nothing was exported.")
  const exportedAt = Date.now()
  const file: RecoveryExportFile = {
    format: RECOVERY_EXPORT_FORMAT,
    formatVersion: RECOVERY_EXPORT_VERSION,
    source: "stored-as-found",
    extensionVersion: EXTENSION_VERSION,
    exportedAt,
    encodedValue: encodeLossless(raw.value),
    ...(raw.hasMeta ? { encodedMeta: encodeLossless(raw.meta) } : {}),
  }
  return { fileName: fileNameFor("found", exportedAt), json: JSON.stringify(file, null, 2) }
}

/** Reads a recovery export file back (for tests and for whatever restores from one later). */
export function parseRecoveryExport(json: string): RecoveryExportFile {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== "object" || parsed === null) throw new Error("Not a recovery export")
  const file = parsed as Partial<RecoveryExportFile>
  if (
    file.format !== RECOVERY_EXPORT_FORMAT ||
    file.formatVersion !== RECOVERY_EXPORT_VERSION ||
    (file.source !== "kept-copy" && file.source !== "stored-as-found") ||
    typeof file.encodedValue !== "string" ||
    (file.encodedMeta !== undefined && typeof file.encodedMeta !== "string") ||
    typeof file.extensionVersion !== "string" ||
    typeof file.exportedAt !== "number"
  ) {
    throw new Error("Not a recovery export")
  }
  return file as RecoveryExportFile
}
