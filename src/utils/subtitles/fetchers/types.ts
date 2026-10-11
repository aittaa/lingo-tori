import type { SubtitlesFragment } from "@/utils/subtitles/types"

export interface SubtitlesFetcher {
  fetch: () => Promise<SubtitlesFragment[]>
  cleanup: () => void
  shouldUseSameTrack: () => Promise<boolean>
  /** Loaded subtitles only, without starting IO; null while unavailable or loading. */
  getCachedSubtitles?: () => SubtitlesFragment[] | null
  /** Synchronous native-track identity for validation within a clipboard gesture. */
  getTrackIdentity?: () => string | null
  getSourceLanguage: () => string
  hasAvailableSubtitles: () => Promise<boolean>
  hideNativeSubtitles?: () => void
  showNativeSubtitles?: () => void
  isPreSegmented?: () => boolean
}
