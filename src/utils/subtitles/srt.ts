import type { SubtitlesFragment } from "@/utils/subtitles/types"

const LINE_BREAK_PATTERN = /\r\n?|\n/

function pad(value: number, size: number): string {
  return String(value).padStart(size, "0")
}

export function formatSrtTimestamp(timeMs: number): string {
  const safeTimeMs = Number.isFinite(timeMs) ? Math.max(0, Math.floor(timeMs)) : 0
  const hours = Math.floor(safeTimeMs / 3_600_000)
  const minutes = Math.floor((safeTimeMs % 3_600_000) / 60_000)
  const seconds = Math.floor((safeTimeMs % 60_000) / 1000)
  const milliseconds = safeTimeMs % 1000

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`
}

function normalizeSubtitleText(text: string): string {
  return text
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

function normalizeSubtitleFragment(fragment: SubtitlesFragment): SubtitlesFragment | null {
  if (!Number.isFinite(fragment.start) || !Number.isFinite(fragment.end)) return null

  const text = normalizeSubtitleText(fragment.text)
  if (!text) {
    return null
  }

  const start = Math.max(0, Math.floor(fragment.start))
  const end = Math.max(start + 1, Math.floor(fragment.end))

  return {
    ...fragment,
    text,
    start,
    end,
  }
}

export function buildSubtitlesSrtContent(subtitles: SubtitlesFragment[]): string {
  return subtitles
    .map(normalizeSubtitleFragment)
    .filter((fragment): fragment is SubtitlesFragment => fragment !== null)
    .map((fragment, index) => {
      return [
        String(index + 1),
        `${formatSrtTimestamp(fragment.start)} --> ${formatSrtTimestamp(fragment.end)}`,
        fragment.text,
      ].join("\n")
    })
    .join("\n\n")
}

/** Invoke directly from a click handler, after subtitle preparation has completed. */
export async function copySubtitlesText(text: string): Promise<void> {
  if (!text.trim()) throw new Error("No subtitle text to copy")
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    throw new Error("Clipboard access is unavailable")
  }
  // No await, permission query or data fetch before this call: preserve activation.
  await navigator.clipboard.writeText(text)
}
