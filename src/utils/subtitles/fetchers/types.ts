import type { SubtitlesFragment } from "@/utils/subtitles/types"

export interface SubtitlesFetchOptions {
  /**
   * The captions are only being read to learn the video's language, not yet wanted on screen. A
   * fetcher that has to change the player's own captions to reach them marks that change as the
   * probe's, so it can be put back through `showNativeSubtitles` if nothing comes of the probe.
   */
  probe?: boolean
}

export interface SubtitlesFetcher {
  fetch: (options?: SubtitlesFetchOptions) => Promise<SubtitlesFragment[]>
  /** Drops cached state and abandons loads still waiting on the page, which then change nothing. */
  cleanup: () => void
  shouldUseSameTrack: () => Promise<boolean>
  /** Loaded subtitles only, without starting IO; null while unavailable or loading. */
  getCachedSubtitles?: () => SubtitlesFragment[] | null
  /** Synchronous native-track identity for validation within a clipboard gesture. */
  getTrackIdentity?: () => string | null
  getSourceLanguage: () => string
  hasAvailableSubtitles: () => Promise<boolean>
  hideNativeSubtitles?: () => void
  /** Puts back the player's own captions as a probe or an earlier load found them. */
  showNativeSubtitles?: () => void
  /**
   * A start has been accepted: whatever a probe changed in the player's own captions now belongs to
   * that session, and is no longer the probe's to put back.
   */
  claimNativeSubtitles?: () => void
  isPreSegmented?: () => boolean
}
