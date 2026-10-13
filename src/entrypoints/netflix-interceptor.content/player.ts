import type {
  NetflixSubtitlesAction,
  NetflixSubtitlesResponse,
} from "@/utils/subtitles/fetchers/netflix"
import {
  NETFLIX_LOAD_TIMEOUT_MS,
  NETFLIX_SUBTITLES_REQUEST_TYPE,
  NETFLIX_SUBTITLES_RESPONSE_TYPE,
  NETFLIX_PAGE_POLL_INTERVAL_MS,
  NETFLIX_PAGE_WAIT_TIMEOUT_MS,
  NETFLIX_WATCH_PATH_PATTERN,
} from "@/utils/constants/subtitles"
import { pollUntil } from "@/utils/poll"
import { findCapturedTtml } from "./ttml-capture"

interface TimedTextTrack {
  trackId: string
  bcp47: string | null
  isNoneTrack: boolean
  isForcedNarrative: boolean
  isImageBased?: boolean
}

interface NetflixPlayer {
  getMovieId: () => number
  getAudioTrack: () => { bcp47?: string } | null
  getTimedTextTrack: () => TimedTextTrack | null
  getTimedTextTrackList: () => TimedTextTrack[]
  setTimedTextTrack: (track: TimedTextTrack) => void
}

// The track a load replaced, and the load that did so: only that load, or a restore that names it,
// may put it back. A newer load on the same movie or the next one replaces the record, and an older
// request can then neither act on it nor spend it.
let replacedTrack: {
  movieId: number
  track: TimedTextTrack
  pickedTrackId: string
  operationId: string | null
} | null = null

// Loads the content script has given up. A request can wait for the player through a navigation or
// a remount, and must not touch the captions of whatever the player shows by the time it is ready.
const MAX_REMEMBERED_OPERATIONS = 200
const cancelledOperations = new Set<string>()

function currentWatchId(): string | null {
  return window.location.pathname.match(NETFLIX_WATCH_PATH_PATTERN)?.[1] ?? null
}

/** What a request says about itself, so the page can tell whether it is still wanted and current. */
interface RequestScope {
  /** The load a request belongs to: what it changes is its own, and it can be given up. */
  operationId?: string
  /** A restore names every load of the fetcher that asks, and acts on the record of one of them. */
  operationIds?: string[]
  /** The movie the page shows and the player must be showing, as the watch URL names it. */
  expectedMovieId?: string | null
}

function putBack(record: NonNullable<typeof replacedTrack>, player: NetflixPlayer): void {
  if (
    record.movieId === player.getMovieId() &&
    player.getTimedTextTrack()?.trackId === record.pickedTrackId
  ) {
    player.setTimedTextTrack(record.track)
  }
}

/**
 * The load is given up: whatever is still queued for it is refused, and a track it already changed
 * is put back while the player still shows that movie. A record that belongs to another load is
 * left as it is; one whose movie has gone from the player has nothing left to put back.
 */
function cancelOperation(operationId: string): void {
  cancelledOperations.add(operationId)
  if (cancelledOperations.size > MAX_REMEMBERED_OPERATIONS) {
    const oldest = cancelledOperations.values().next().value
    if (oldest !== undefined) cancelledOperations.delete(oldest)
  }
  const record = replacedTrack
  if (record?.operationId !== operationId) return
  replacedTrack = null
  const player = getReadyPlayer()
  if (player) putBack(record, player)
}

// Returned from a wait that no longer has anything to wait for.
const STALE = Symbol("stale")

// Each wait gets whatever time is left before the request's deadline.
function untilDeadline(deadline: number) {
  return { timeoutMs: deadline - Date.now(), intervalMs: NETFLIX_PAGE_POLL_INTERVAL_MS }
}

function emptyResponse(requestId: string): NetflixSubtitlesResponse {
  return {
    type: NETFLIX_SUBTITLES_RESPONSE_TYPE,
    requestId,
    movieId: null,
    trackId: null,
    translatable: false,
    ttml: null,
  }
}

function getReadyPlayer(): NetflixPlayer | null {
  try {
    const videoPlayer = (window as any).netflix.appContext.state.playerApp.getAPI().videoPlayer
    const sessionIds: string[] = videoPlayer.getAllPlayerSessionIds()
    const sessionId = sessionIds.find((id) => id.startsWith("watch")) ?? sessionIds[0]
    const player: NetflixPlayer | undefined = sessionId
      ? videoPlayer.getVideoPlayerBySessionId(sessionId)
      : undefined
    return player?.getTimedTextTrackList().length ? player : null
  } catch {
    return null
  }
}

function isTranslatable(track: TimedTextTrack | null): track is TimedTextTrack {
  return !!track && !track.isNoneTrack && !track.isForcedNarrative && !track.isImageBased
}

function primaryLanguage(language: string | null | undefined): string {
  return language?.split("-")[0]?.toLowerCase() ?? ""
}

function ensureTranslatableTrack(
  player: NetflixPlayer,
  operationId: string | null,
): TimedTextTrack | null {
  const current = player.getTimedTextTrack()
  if (isTranslatable(current)) return current

  const tracks = player.getTimedTextTrackList().filter(isTranslatable)
  const audioLanguage = primaryLanguage(player.getAudioTrack()?.bcp47)
  const next =
    tracks.find((track) => primaryLanguage(track.bcp47) === audioLanguage) ??
    tracks.find((track) => primaryLanguage(track.bcp47) === "en") ??
    tracks[0]
  if (!next) return null

  if (current) {
    replacedTrack = {
      movieId: player.getMovieId(),
      track: current,
      pickedTrackId: next.trackId,
      operationId,
    }
  }
  player.setTimedTextTrack(next)
  return next
}

async function handleRequest(
  requestId: string,
  action: NetflixSubtitlesAction,
  scope: RequestScope = {},
): Promise<NetflixSubtitlesResponse> {
  const response = emptyResponse(requestId)
  if (action === "cancel") {
    if (scope.operationId) cancelOperation(scope.operationId)
    return response
  }

  // Whatever changes the player's captions must be wanted still, be for the movie the page shows,
  // and meet a player that actually shows that movie: the URL can move before the player does, and
  // a request for one title is never run against another's. A state check only reads, and reports
  // whatever the player shows.
  const mutates = action !== "state"
  const isCancelled = () => !!scope.operationId && cancelledOperations.has(scope.operationId)
  const isStale = () =>
    isCancelled() ||
    typeof scope.expectedMovieId !== "string" ||
    scope.expectedMovieId !== currentWatchId()
  const showsExpectedMovie = (candidate: NetflixPlayer) =>
    String(candidate.getMovieId()) === scope.expectedMovieId

  // A load shares one deadline between the player and its subtitle file, so the content
  // script knows the longest it can take.
  const deadline =
    Date.now() + (action === "load" ? NETFLIX_LOAD_TIMEOUT_MS : NETFLIX_PAGE_WAIT_TIMEOUT_MS)
  const player = await pollUntil<NetflixPlayer | typeof STALE>(() => {
    if (mutates && isStale()) return STALE
    const ready = getReadyPlayer()
    if (!ready) return null
    return !mutates || showsExpectedMovie(ready) ? ready : null
  }, untilDeadline(deadline))
  if (!player || player === STALE) return response

  // The wait above ended on its own terms; nothing may sit between this check and the change.
  if (mutates && (isStale() || !showsExpectedMovie(player))) return response

  const movieId = player.getMovieId()
  if (action === "restore") {
    const record = replacedTrack
    if (record?.operationId && scope.operationIds?.includes(record.operationId)) {
      replacedTrack = null
      putBack(record, player)
    }
  }

  const track =
    action === "load"
      ? ensureTranslatableTrack(player, scope.operationId ?? null)
      : player.getTimedTextTrack()
  response.movieId = movieId
  response.trackId = track?.trackId ?? null
  response.translatable = isTranslatable(track)
  if (action === "load" && track && response.translatable) {
    // A load given up while it waits for its file stops waiting; the empty answer is never used.
    response.ttml = await pollUntil(
      () => (isCancelled() ? "" : findCapturedTtml(movieId, track.trackId)),
      untilDeadline(deadline),
    )
  }
  return response
}

export function listenForSubtitlesRequests(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (
      event.origin !== window.location.origin ||
      event.data?.type !== NETFLIX_SUBTITLES_REQUEST_TYPE
    ) {
      return
    }
    const { requestId, action, operationId, operationIds, expectedMovieId } = event.data
    // Answer even when reading the player throws, so the content script is not left waiting.
    void handleRequest(requestId, action, { operationId, operationIds, expectedMovieId })
      .catch(() => emptyResponse(requestId))
      .then((response) => window.postMessage(response, window.location.origin))
  })
}
