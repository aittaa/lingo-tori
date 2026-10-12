import { i18n } from "@/utils/i18n"

// Locale files are coordinated in a separate PR. Keep this branch usable until then.
const COPY_MESSAGES = {
  copySource: "Copy source subtitles",
  copyTranslated: "Copy translated subtitles",
  copyPreparing: "Preparing subtitles, longer videos may take a while",
  copyTranslating: "Translating subtitles",
  copyReady: "Subtitles ready. Click Copy to copy them.",
  copyComplete: "Subtitles copied to clipboard",
  copyRetry: "Retry copy",
  copyFailed:
    "Could not copy subtitles. Focus the video tab, allow clipboard access if prompted, and retry.",
  copyUnavailable: "Clipboard access is unavailable on this page.",
} as const

type CopyMessageKey = `subtitles.actions.${keyof typeof COPY_MESSAGES}`
const translateCopyMessage = i18n.t as (key: CopyMessageKey) => string

export function subtitleCopyMessage(key: keyof typeof COPY_MESSAGES): string {
  return translateCopyMessage(`subtitles.actions.${key}`) || COPY_MESSAGES[key]
}
