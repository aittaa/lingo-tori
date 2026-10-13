import type { SubtitlesFragment } from "../../types"
import type { SubtitlesFetcher, SubtitlesFetchOptions } from "../types"
import type { CaptionTrack, PlayerData, YoutubeCaptionsAction, YoutubeTimedText } from "./types"
import { getLocalConfig } from "@/utils/config/storage"
import {
  ENSURE_SUBTITLES_REQUEST_TYPE,
  ENSURE_SUBTITLES_RESPONSE_TYPE,
  FETCH_RETRY_DELAY_MS,
  MAX_FETCH_RETRIES,
  MAX_POT_WAIT_ATTEMPTS,
  MAX_SELECTED_TRACK_WAIT_ATTEMPTS,
  MAX_STATE_WAIT_ATTEMPTS,
  PLAYER_DATA_REQUEST_TYPE,
  PLAYER_DATA_RESPONSE_TYPE,
  POT_WAIT_INTERVAL_MS,
  SELECTED_TRACK_WAIT_INTERVAL_MS,
  STATE_WAIT_INTERVAL_MS,
  WAIT_TIMEDTEXT_REQUEST_TYPE,
  WAIT_TIMEDTEXT_RESPONSE_TYPE,
} from "@/utils/constants/subtitles"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { sleep } from "@/utils/sleep"
import { OverlaySubtitlesError } from "@/utils/subtitles/errors"
import { postMessageRequest } from "@/utils/subtitles/fetchers/post-message-request"
import { getYoutubeVideoId } from "@/utils/subtitles/video-id"
import { detectFormat } from "./format-detector"
import { filterNoiseFromEvents } from "./noise-filter"
import {
  parseAnimatedSubtitles,
  parseKaraokeSubtitles,
  parseScrollingAsrSubtitles,
  parseStandardSubtitles,
  parseStylizedKaraokeSubtitles,
} from "./parser"
import { extractPotToken } from "./pot-token"
import { youtubeSubtitlesResponseSchema } from "./types"
import { buildSubtitleUrl } from "./url-builder"

function hasSelectedTrack(playerData: PlayerData): boolean {
  return Boolean(playerData.selectedTrackVssId || playerData.selectedTrackLanguageCode)
}

function getDefaultTrack(playerData: PlayerData): CaptionTrack | null {
  const index = playerData.defaultCaptionTrackIndex
  if (index === null) return null
  return playerData.captionTracks[index] ?? null
}

export async function requestPlayerData(videoId: string): Promise<{
  success: boolean
  error?: string
  data?: PlayerData
}> {
  const resp = await postMessageRequest(PLAYER_DATA_RESPONSE_TYPE, {
    type: PLAYER_DATA_REQUEST_TYPE,
    expectedVideoId: videoId,
  })
  if (!resp) return { success: false, error: "TIMEOUT" }
  return { success: resp.success, error: resp.error, data: resp.data }
}

/** One call to `fetch`: what the page is told about it, and whether it has been given up. */
interface FetchOperation {
  id: string
  probe: boolean
  cancelled: boolean
}

function assertNotCancelled(operation: FetchOperation): void {
  if (operation.cancelled) {
    throw new DOMException("Subtitle load cancelled", "AbortError")
  }
}

export class YoutubeSubtitlesFetcher implements SubtitlesFetcher {
  private subtitles: SubtitlesFragment[] = []
  private sourceLanguage: string = ""
  private cachedTrackHash: string | null = null
  private preSegmented: boolean = false
  private pendingOperations = new Set<FetchOperation>()
  // Probes whose changes to the player's captions are still theirs to put back, by the video each
  // read. Ended by a restore the page has answered, a claim by an accepted session, or cleanup.
  private unsettledProbes = new Map<string, string>()

  async fetch(options?: SubtitlesFetchOptions): Promise<SubtitlesFragment[]> {
    const videoId = getYoutubeVideoId()
    if (!videoId) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.videoNotFound"))
    }

    const operation: FetchOperation = {
      id: getRandomUUID(),
      probe: options?.probe === true,
      cancelled: false,
    }
    this.pendingOperations.add(operation)
    // Registered before anything is asked of the page, so a path that never asks (cached captions)
    // is still the probe's to end.
    if (operation.probe) this.unsettledProbes.set(operation.id, videoId)
    try {
      const currentHash = await this.computeTrackHash()
      assertNotCancelled(operation)

      if (currentHash && this.subtitles.length > 0 && this.cachedTrackHash === currentHash) {
        return this.subtitles
      }

      const fastPathResult = await this.tryFastFetch(videoId, operation)
      let resolvedTrack = fastPathResult.track
      let events = fastPathResult.events

      if (!events) {
        const fallbackResult = await this.fetchWithFallback(
          videoId,
          fastPathResult.track,
          operation,
        )
        resolvedTrack = fallbackResult.track
        events = fallbackResult.events
      }

      if (!resolvedTrack) {
        throw new OverlaySubtitlesError(i18n.t("subtitles.errors.noSubtitlesFound"))
      }

      assertNotCancelled(operation)
      this.sourceLanguage = resolvedTrack.languageCode
      const subtitles = await this.processRawEvents(events)
      // A load given up while it ran must not fill the cache that cleanup just emptied.
      assertNotCancelled(operation)
      this.subtitles = subtitles
      this.cachedTrackHash = this.buildTrackHash(videoId, resolvedTrack)

      return this.subtitles
    } finally {
      this.pendingOperations.delete(operation)
    }
  }

  /**
   * Puts back the captions that probes of this fetcher switched on, if the page still has them as
   * the probe left them. Each request names the probe and its video: the page acts on a record that
   * matches both, and on no other.
   */
  showNativeSubtitles(): void {
    for (const [operationId, videoId] of this.unsettledProbes) {
      void postMessageRequest(ENSURE_SUBTITLES_RESPONSE_TYPE, {
        type: ENSURE_SUBTITLES_REQUEST_TYPE,
        action: "restore" satisfies YoutubeCaptionsAction,
        expectedVideoId: videoId,
        operationId,
      }).then(() => {
        // A probe still reading may switch the captions on after this answer, and then has this to
        // do again: only one that has finished is settled by it.
        const isRunning = [...this.pendingOperations].some(
          (operation) => operation.id === operationId,
        )
        if (!isRunning) this.unsettledProbes.delete(operationId)
      })
    }
  }

  /**
   * A start was accepted: the page drops its record of what these probes changed, and refuses to
   * record anything they still ask for. A restore of theirs that is still on its way finds nothing
   * to undo.
   */
  claimNativeSubtitles(): void {
    if (this.unsettledProbes.size === 0) return
    const operationIds = [...this.unsettledProbes.keys()]
    this.unsettledProbes.clear()
    void postMessageRequest(ENSURE_SUBTITLES_RESPONSE_TYPE, {
      type: ENSURE_SUBTITLES_REQUEST_TYPE,
      action: "claim" satisfies YoutubeCaptionsAction,
      operationIds,
    })
  }

  getSourceLanguage(): string {
    return this.sourceLanguage
  }

  isPreSegmented(): boolean {
    return this.preSegmented
  }

  cleanup(): void {
    // Loads still waiting end at their next step. The page is told to give up every load and probe
    // of this fetcher: it refuses what is still queued for them, and undoes what a probe already
    // changed while the player is still on the video it changed it for.
    const abandoned = new Set([
      ...[...this.pendingOperations].map((operation) => operation.id),
      ...this.unsettledProbes.keys(),
    ])
    for (const operation of this.pendingOperations) operation.cancelled = true
    for (const operationId of abandoned) {
      void postMessageRequest(ENSURE_SUBTITLES_RESPONSE_TYPE, {
        type: ENSURE_SUBTITLES_REQUEST_TYPE,
        action: "cancel" satisfies YoutubeCaptionsAction,
        operationId,
      })
    }
    this.pendingOperations.clear()
    this.unsettledProbes.clear()
    this.subtitles = []
    this.sourceLanguage = ""
    this.cachedTrackHash = null
    this.preSegmented = false
  }

  async hasAvailableSubtitles(): Promise<boolean> {
    const videoId = getYoutubeVideoId()
    if (!videoId) {
      return false
    }

    const response = await this.requestPlayerData(videoId)
    return (
      response.success &&
      response.data !== null &&
      response.data !== undefined &&
      response.data.captionTracks.length > 0
    )
  }

  async shouldUseSameTrack(): Promise<boolean> {
    if (this.subtitles.length === 0 || !this.cachedTrackHash) {
      return false
    }

    try {
      const currentHash = await this.computeTrackHash()
      return currentHash !== null && this.cachedTrackHash === currentHash
    } catch {
      return false
    }
  }

  private async computeTrackHash(): Promise<string | null> {
    const videoId = getYoutubeVideoId()
    if (!videoId) {
      return null
    }

    const response = await this.requestPlayerData(videoId)
    if (!response.success || !response.data) {
      return null
    }

    const track = this.selectTrack(response.data)
    return this.buildTrackHash(videoId, track)
  }

  private buildTrackHash(videoId: string, track: CaptionTrack | null): string | null {
    if (!track) {
      return null
    }

    return `${videoId}:${track.languageCode}:${track.kind ?? ""}:${track.vssId}`
  }

  private async tryFastFetch(
    videoId: string,
    operation: FetchOperation,
  ): Promise<{
    currentHash: string | null
    track: CaptionTrack | null
    events: YoutubeTimedText[] | null
  }> {
    const response = await this.requestPlayerData(videoId)
    if (!response.success || !response.data) {
      return {
        currentHash: null,
        track: null,
        events: null,
      }
    }

    const playerData = await this.ensureTrackSelection(videoId, response.data, operation)
    const track = this.selectTrack(playerData)
    const currentHash = this.buildTrackHash(videoId, track)

    if (!track) {
      return {
        currentHash,
        track: null,
        events: null,
      }
    }

    try {
      const events = await this.fetchTrackEvents(track, playerData)
      return {
        currentHash,
        track,
        events,
      }
    } catch {
      return {
        currentHash,
        track,
        events: null,
      }
    }
  }

  private async fetchWithFallback(
    videoId: string,
    preferredTrack: CaptionTrack | null,
    operation: FetchOperation,
  ): Promise<{
    track: CaptionTrack
    events: YoutubeTimedText[]
  }> {
    // Wait for player state >= 1 before retrying with the slower POT/timedtext flow.
    await this.waitForPlayerState(videoId)
    assertNotCancelled(operation)

    const playerData = await this.getPlayerDataWithPot(videoId, operation)
    const track = this.selectTrack(playerData) ?? preferredTrack

    if (!track) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.noSubtitlesFound"))
    }

    const events = await this.fetchTrackEvents(track, playerData)
    return { track, events }
  }

  private async ensureTrackSelection(
    videoId: string,
    playerData: PlayerData,
    operation: FetchOperation,
  ): Promise<PlayerData> {
    if (
      playerData.captionTracks.length === 0 ||
      hasSelectedTrack(playerData) ||
      getDefaultTrack(playerData)
    ) {
      return playerData
    }

    await this.ensureSubtitlesEnabled(videoId, operation)

    let latest = playerData
    for (let i = 0; i < MAX_SELECTED_TRACK_WAIT_ATTEMPTS; i++) {
      const response = await this.requestPlayerData(videoId)
      assertNotCancelled(operation)
      if (response.success && response.data) {
        latest = response.data
        if (hasSelectedTrack(latest)) {
          return latest
        }
      }

      await sleep(SELECTED_TRACK_WAIT_INTERVAL_MS)
    }

    return latest
  }

  private async waitForPlayerState(videoId: string): Promise<void> {
    for (let i = 0; i < MAX_STATE_WAIT_ATTEMPTS; i++) {
      const response = await this.requestPlayerData(videoId)

      if (response.success && response.data && response.data.playerState >= 1) {
        return
      }

      await sleep(STATE_WAIT_INTERVAL_MS)
    }
  }

  private async getPlayerDataWithPot(
    videoId: string,
    operation: FetchOperation,
  ): Promise<PlayerData> {
    const response = await this.requestPlayerData(videoId)
    assertNotCancelled(operation)

    if (!response.success || !response.data) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.fetchSubTimeout"))
    }

    let playerData = response.data

    if (this.hasPotInAudioTracks(playerData) || playerData.cachedTimedtextUrl) {
      return playerData
    }

    if (playerData.captionTracks.length === 0) {
      return playerData
    }

    await this.ensureSubtitlesEnabled(videoId, operation)

    for (let i = 0; i < MAX_POT_WAIT_ATTEMPTS; i++) {
      await sleep(POT_WAIT_INTERVAL_MS)
      const pollResponse = await this.requestPlayerData(videoId)
      assertNotCancelled(operation)
      if (pollResponse.success && pollResponse.data) {
        playerData = pollResponse.data
        if (this.hasPotInAudioTracks(playerData) || playerData.cachedTimedtextUrl) {
          return playerData
        }
      }
    }

    const timedtextUrl = await this.waitForTimedtextUrl(videoId)
    if (timedtextUrl) {
      playerData.cachedTimedtextUrl = timedtextUrl
    }

    return playerData
  }

  private async fetchTrackEvents(
    track: CaptionTrack,
    playerData: PlayerData,
  ): Promise<YoutubeTimedText[]> {
    const potToken = extractPotToken(track, playerData)
    const url = buildSubtitleUrl(track, playerData, potToken)
    return this.fetchWithRetry(url)
  }

  private hasPotInAudioTracks(playerData: PlayerData): boolean {
    return playerData.audioCaptionTracks.some((t) => {
      try {
        return new URL(t.url).searchParams.has("pot")
      } catch {
        return false
      }
    })
  }

  private async waitForTimedtextUrl(videoId: string): Promise<string | null> {
    const resp = await postMessageRequest(WAIT_TIMEDTEXT_RESPONSE_TYPE, {
      type: WAIT_TIMEDTEXT_REQUEST_TYPE,
      videoId,
    })
    return resp?.url ?? null
  }

  private requestPlayerData(videoId: string) {
    return requestPlayerData(videoId)
  }

  // The page acts only if this operation is still wanted and the player still shows this video.
  private async ensureSubtitlesEnabled(videoId: string, operation: FetchOperation): Promise<void> {
    assertNotCancelled(operation)
    await postMessageRequest(ENSURE_SUBTITLES_RESPONSE_TYPE, {
      type: ENSURE_SUBTITLES_REQUEST_TYPE,
      action: "ensure" satisfies YoutubeCaptionsAction,
      expectedVideoId: videoId,
      operationId: operation.id,
      probe: operation.probe,
    })
    assertNotCancelled(operation)
  }

  /**
   * Select the best subtitle track from available tracks.
   *
   * Priority order:
   * 1. User's currently selected track in YouTube player (if available)
   * 2. Human-created subtitles without name (original language, highest quality)
   * 3. Human-created subtitles with name (may be translated versions)
   * 4. Auto-generated ASR subtitles (lower quality but better than nothing)
   * 5. First available track as fallback
   */
  private selectTrack(playerData: PlayerData): CaptionTrack | null {
    const { captionTracks: tracks, selectedTrackLanguageCode, selectedTrackVssId } = playerData

    if (tracks.length === 0) return null

    // Priority 1: User's selected track in YouTube player
    if (selectedTrackVssId) {
      const selectedTrack = tracks.find((t) => t.vssId === selectedTrackVssId)
      if (selectedTrack) return selectedTrack
    }

    if (selectedTrackLanguageCode) {
      const selectedTrack = tracks.find((t) => t.languageCode === selectedTrackLanguageCode)
      if (selectedTrack) return selectedTrack
    }

    const defaultTrack = getDefaultTrack(playerData)
    if (defaultTrack) return defaultTrack

    // Priority 2: Human subtitles without name - these are typically the original
    // language subtitles uploaded by the video creator
    const humanExact = tracks.find((t) => t.kind !== "asr" && !t.name)
    if (humanExact) return humanExact

    // Priority 3: Human subtitles with name - may be translated or have additional metadata
    const humanWithName = tracks.find((t) => t.kind !== "asr")
    if (humanWithName) return humanWithName

    // Priority 4: Auto-generated speech recognition subtitles
    const asr = tracks.find((t) => t.kind === "asr")
    if (asr) return asr

    return tracks[0] ?? null
  }

  private async fetchWithRetry(url: string): Promise<YoutubeTimedText[]> {
    let lastError: Error | null = null

    for (let i = 0; i < MAX_FETCH_RETRIES; i++) {
      try {
        const response = await fetch(url)

        if (!response.ok) {
          const status = response.status
          switch (status) {
            // Permanent errors - don't retry
            case 403:
              throw new OverlaySubtitlesError(i18n.t("subtitles.errors.http403"))
            case 404:
              throw new OverlaySubtitlesError(i18n.t("subtitles.errors.http404"))
            case 429:
              throw new OverlaySubtitlesError(i18n.t("subtitles.errors.http429"))
            // Retryable errors - throw and let retry logic handle
            case 500:
              throw new Error(i18n.t("subtitles.errors.http500"))
            default:
              throw new Error(i18n.t("subtitles.errors.httpUnknown", [status]))
          }
        }

        const data = await response.json()
        const parsed = youtubeSubtitlesResponseSchema.safeParse(data)
        if (!parsed.success) {
          throw new Error("Invalid response format")
        }

        return parsed.data.events
      } catch (e) {
        // Don't retry permanent errors (OverlaySubtitlesError)
        if (e instanceof OverlaySubtitlesError) {
          throw e
        }
        lastError = e instanceof Error ? e : new Error(String(e))
        if (i < MAX_FETCH_RETRIES - 1) {
          await sleep(FETCH_RETRY_DELAY_MS)
        }
      }
    }

    throw new OverlaySubtitlesError(
      lastError?.message ?? i18n.t("subtitles.errors.fetchSubTimeout"),
    )
  }

  private async processRawEvents(events: YoutubeTimedText[]): Promise<SubtitlesFragment[]> {
    const config = await getLocalConfig()
    const enableAISegmentation = config?.videoSubtitles?.aiSegmentation ?? false

    this.preSegmented = false
    const filteredEvents = filterNoiseFromEvents(events)
    const format = detectFormat(filteredEvents)

    if (format === "karaoke") {
      return parseKaraokeSubtitles(filteredEvents)
    }

    if (format === "karaoke-stylized") {
      return parseStylizedKaraokeSubtitles(filteredEvents)
    }

    if (format === "animated") {
      this.preSegmented = true
      return parseAnimatedSubtitles(filteredEvents)
    }

    if (enableAISegmentation) {
      return parseStandardSubtitles(filteredEvents)
    }

    const fragments =
      format === "scrolling-asr"
        ? parseScrollingAsrSubtitles(filteredEvents, this.sourceLanguage)
        : parseStandardSubtitles(filteredEvents)

    return fragments
  }
}
