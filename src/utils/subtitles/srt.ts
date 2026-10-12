import type { SubtitlesFragment } from "@/utils/subtitles/types"

const LINE_BREAK_PATTERN = /\r\n?|\n/

function normalizeSubtitleText(text: string): string {
  return text
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

/** Copy dialogue in cue order; timing and numbering are not clipboard content. */
export function buildSubtitlesCopyText(subtitles: SubtitlesFragment[]): string {
  return subtitles
    .map((fragment) => normalizeSubtitleText(fragment.text))
    .filter(Boolean)
    .join("\n")
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
