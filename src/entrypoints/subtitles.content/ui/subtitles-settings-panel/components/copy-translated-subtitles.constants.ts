export const COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS = 600

export const COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE = {
  Muted: "muted",
  Success: "success",
} as const

export type CopyTranslatedSubtitlesMessageTone =
  (typeof COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE)[keyof typeof COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE]
