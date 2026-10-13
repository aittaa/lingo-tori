import type { PlayerDataResponse } from "./utils"
import type { YoutubeCaptionsAction } from "@/utils/subtitles/fetchers/youtube/types"
import {
  ENSURE_SUBTITLES_REQUEST_TYPE,
  ENSURE_SUBTITLES_RESPONSE_TYPE,
  PLAYER_DATA_REQUEST_TYPE,
  PLAYER_DATA_RESPONSE_TYPE,
  TIMEDTEXT_WAIT_TIMEOUT_MS,
  WAIT_TIMEDTEXT_REQUEST_TYPE,
  WAIT_TIMEDTEXT_RESPONSE_TYPE,
} from "@/utils/constants/subtitles"
import {
  getCachedTimedtextUrl,
  setupTimedtextObserver,
  waitForTimedtextUrl,
} from "./timedtext-observer"
import {
  errorResponse,
  normalizeTracks,
  parseAudioTracks,
  resolveDefaultCaptionTrackIndex,
} from "./utils"

interface PlayerDataRequest {
  type: typeof PLAYER_DATA_REQUEST_TYPE
  requestId: string
  expectedVideoId: string
}

interface CaptionsRequest {
  type: typeof ENSURE_SUBTITLES_REQUEST_TYPE
  requestId: string
  action?: YoutubeCaptionsAction
  expectedVideoId?: string
  /** The fetch the request belongs to: what it changed is its own, and it can be given up. */
  operationId?: string
  /** A claim names every fetch whose changes now belong to an accepted session. */
  operationIds?: string[]
  /** The captions are only being read to learn the video's language. */
  probe?: boolean
}

const MAX_REMEMBERED_OPERATIONS = 200
const cancelledOperations = new Set<string>()
// Fetches whose changes an accepted session took over: nothing of theirs is put back any more.
const claimedOperations = new Set<string>()
// The captions a probe switched on, and the fetch that did so, until that fetch puts them back,
// is given up, or has its change claimed by a session.
let probeOwnedCaptions: { videoId: string; operationId: string } | null = null

interface YouTubePlayer extends HTMLElement {
  getPlayerResponse?: () => any
  getAudioTrack?: () => any
  getPlayerState?: () => number
  getWebPlayerContextConfig?: () => any
  getOption?: (module: string, option: string) => any
  toggleSubtitles?: () => void
}

declare global {
  interface Window {
    ytcfg?: {
      get?: (key: string) => string | undefined
    }
  }
}

interface SelectedTrackSnapshot {
  languageCode: string | null
  vssId: string | null
}

function findYoutubePlayer(): YouTubePlayer | null {
  const shortsActive = document.querySelector<YouTubePlayer>(
    "#reel-overlay-container .html5-video-player",
  )
  if (shortsActive) return shortsActive

  return (
    document.querySelector(".html5-video-player.playing-mode, .html5-video-player.paused-mode") ??
    document.querySelector(".html5-video-player")
  )
}

export function injectPlayerApi(): void {
  if ((window as any).__READ_FROG_INTERCEPTOR_INJECTED__) {
    return
  }
  ;(window as any).__READ_FROG_INTERCEPTOR_INJECTED__ = true

  setupTimedtextObserver()
  window.addEventListener("message", handleMessage)
}

function handleMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return

  if (event.data?.type === PLAYER_DATA_REQUEST_TYPE) {
    const request = event.data as PlayerDataRequest
    const response = getPlayerData(request)
    window.postMessage(response, window.location.origin)
  }

  if (event.data?.type === WAIT_TIMEDTEXT_REQUEST_TYPE) {
    const { requestId, videoId } = event.data
    void waitForTimedtextUrl(videoId, TIMEDTEXT_WAIT_TIMEOUT_MS).then((url) => {
      window.postMessage(
        {
          type: WAIT_TIMEDTEXT_RESPONSE_TYPE,
          requestId,
          url,
        },
        window.location.origin,
      )
    })
  }

  if (event.data?.type === ENSURE_SUBTITLES_REQUEST_TYPE) {
    const { requestId } = event.data
    handleCaptionsRequest(event.data as CaptionsRequest)
    window.postMessage(
      {
        type: ENSURE_SUBTITLES_RESPONSE_TYPE,
        requestId,
      },
      window.location.origin,
    )
  }
}

function getPlayerData(request: PlayerDataRequest): PlayerDataResponse {
  const { requestId, expectedVideoId } = request

  try {
    const player = findYoutubePlayer()

    if (!player) return errorResponse(requestId, "PLAYER_NOT_FOUND")

    const playerResponse = player.getPlayerResponse?.()
    const videoId = playerResponse?.videoDetails?.videoId
    const tracklistRenderer = playerResponse?.captions?.playerCaptionsTracklistRenderer
    const tracks = tracklistRenderer?.captionTracks ?? []
    const captionTracks = normalizeTracks(tracks)
    const selectedTrack = getSelectedTrackSnapshot(player, captionTracks)

    if (!videoId || videoId !== expectedVideoId)
      return errorResponse(requestId, "VIDEO_ID_MISMATCH")

    return {
      type: PLAYER_DATA_RESPONSE_TYPE,
      requestId,
      success: true,
      data: {
        videoId,
        captionTracks,
        audioCaptionTracks: parseAudioTracks(player.getAudioTrack?.()?.captionTracks),
        device: window.ytcfg?.get?.("DEVICE") ?? null,
        cver: player.getWebPlayerContextConfig?.()?.innertubeContextClientVersion ?? null,
        playerState: player.getPlayerState?.() ?? -1,
        selectedTrackLanguageCode: selectedTrack.languageCode,
        selectedTrackVssId: selectedTrack.vssId,
        defaultCaptionTrackIndex: resolveDefaultCaptionTrackIndex(
          tracklistRenderer,
          captionTracks.length,
        ),
        cachedTimedtextUrl: getCachedTimedtextUrl(videoId),
        isLiveContent: !!playerResponse?.videoDetails?.isLiveContent,
      },
    }
  } catch (e) {
    return errorResponse(requestId, String(e))
  }
}

function getPlayerVideoId(player: YouTubePlayer): string | null {
  return player.getPlayerResponse?.()?.videoDetails?.videoId ?? null
}

function handleCaptionsRequest(request: CaptionsRequest): void {
  const { action = "ensure", expectedVideoId, operationId, operationIds, probe } = request
  if (action === "cancel") {
    if (operationId) cancelOperation(operationId)
    return
  }
  if (action === "claim") {
    claimOperations(operationIds ?? [])
    return
  }
  if (action === "restore") {
    restoreProbeCaptions(expectedVideoId, operationId)
    return
  }
  ensureSubtitlesEnabled(expectedVideoId, operationId, probe === true)
}

function remember(operations: Set<string>, operationId: string): void {
  operations.add(operationId)
  if (operations.size > MAX_REMEMBERED_OPERATIONS) {
    const oldest = operations.values().next().value
    if (oldest !== undefined) operations.delete(oldest)
  }
}

/**
 * The fetch is given up: whatever of it is still queued is refused, and what it already changed is
 * reclaimed while the player is still on the video it changed it for. A record belonging to any
 * other fetch is left as it is.
 */
function cancelOperation(operationId: string): void {
  remember(cancelledOperations, operationId)
  const owned = probeOwnedCaptions
  if (owned?.operationId !== operationId) return
  probeOwnedCaptions = null
  revertCaptions(owned)
}

/** An accepted session takes over what these fetches changed: it is no longer theirs to undo. */
function claimOperations(operationIds: string[]): void {
  for (const operationId of operationIds) remember(claimedOperations, operationId)
  const owned = probeOwnedCaptions
  if (owned && operationIds.includes(owned.operationId)) probeOwnedCaptions = null
}

function toggleCaptions(player: YouTubePlayer | null, button: Element): void {
  if (player?.toggleSubtitles) {
    player.toggleSubtitles()
  } else if (button instanceof HTMLElement) {
    button.click()
  }
}

/**
 * Switches the player's captions on, but only for the video the request was made for and only
 * while the request has not been given up: a load that waited through a navigation must not touch
 * the next video's player. A change a probe asked for is remembered as the probe's, to be put back
 * if nothing comes of it; a request from the viewer's own flow takes over any such change.
 */
function ensureSubtitlesEnabled(
  expectedVideoId: string | undefined,
  operationId: string | undefined,
  probe: boolean,
): void {
  if (operationId && cancelledOperations.has(operationId)) return

  const player = findYoutubePlayer()
  if (!expectedVideoId || !player || getPlayerVideoId(player) !== expectedVideoId) return

  if (!probe) probeOwnedCaptions = null

  const button = document.querySelector(".ytp-subtitles-button")
  if (!button) return

  if (button.getAttribute("aria-pressed") === "true") return

  toggleCaptions(player, button)
  // Only a probe that no session has claimed owns what it changed.
  if (probe && operationId && !claimedOperations.has(operationId)) {
    probeOwnedCaptions = { videoId: expectedVideoId, operationId }
  }
}

/**
 * Switches the captions back off if they are still as the probe left them and still on the video it
 * did so for: a viewer who switched them off in the meantime has already decided, and another
 * video's player is not this record's to touch.
 */
function revertCaptions(owned: { videoId: string }): void {
  const player = findYoutubePlayer()
  const button = document.querySelector(".ytp-subtitles-button")
  if (!player || !button || getPlayerVideoId(player) !== owned.videoId) return
  if (button.getAttribute("aria-pressed") !== "true") return

  toggleCaptions(player, button)
}

/**
 * Puts the captions back after the probe that switched them on, named by both its video and its
 * fetch. A record that belongs to another fetch, even a newer one on the same video, is neither
 * acted on nor spent.
 */
function restoreProbeCaptions(
  expectedVideoId: string | undefined,
  operationId: string | undefined,
): void {
  const owned = probeOwnedCaptions
  if (!owned || !operationId) return
  if (owned.operationId !== operationId || owned.videoId !== expectedVideoId) return
  probeOwnedCaptions = null
  revertCaptions(owned)
}

function getSelectedTrackSnapshot(
  player: YouTubePlayer,
  captionTracks: Array<{ languageCode: string; kind?: string; vssId: string }>,
): SelectedTrackSnapshot {
  const selectedTrack = player.getOption?.("captions", "track")
  const languageCode = selectedTrack?.languageCode ?? null
  const matchedTrack = matchSelectedTrack(captionTracks, selectedTrack)
  const vssId = getSelectedTrackVssId(selectedTrack) ?? matchedTrack?.vssId ?? null

  return {
    languageCode,
    vssId,
  }
}

function getSelectedTrackVssId(selectedTrack: any): string | null {
  const directVssId = selectedTrack?.vssId ?? selectedTrack?.vss_id
  if (typeof directVssId === "string" && directVssId.length > 0) return directVssId

  const baseUrl = selectedTrack?.baseUrl
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null

  try {
    return (
      new URL(baseUrl, window.location.origin).searchParams.get("vssId") ??
      new URL(baseUrl, window.location.origin).searchParams.get("vss_id")
    )
  } catch {
    return null
  }
}

function matchSelectedTrack(
  captionTracks: Array<{ languageCode: string; kind?: string; vssId: string }>,
  selectedTrack: any,
) {
  const selectedVssId = getSelectedTrackVssId(selectedTrack)
  if (selectedVssId) {
    return captionTracks.find((track) => track.vssId === selectedVssId)
  }

  const selectedLanguageCode = selectedTrack?.languageCode
  const selectedKind = selectedTrack?.kind ?? selectedTrack?.trackKind ?? null

  if (typeof selectedLanguageCode !== "string" || selectedLanguageCode.length === 0)
    return undefined

  if (typeof selectedKind === "string" && selectedKind.length > 0) {
    const exactKindMatch = captionTracks.find(
      (track) =>
        track.languageCode === selectedLanguageCode && (track.kind ?? null) === selectedKind,
    )
    if (exactKindMatch) return exactKindMatch
  }

  const sameLanguageTracks = captionTracks.filter(
    (track) => track.languageCode === selectedLanguageCode,
  )
  if (sameLanguageTracks.length === 1) return sameLanguageTracks[0]

  return undefined
}
