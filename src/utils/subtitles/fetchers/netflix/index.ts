import type { SubtitlesFetcher } from "../types"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { z } from "zod"
import {
  NETFLIX_LOAD_POST_MESSAGE_TIMEOUT_MS,
  NETFLIX_SUBTITLES_REQUEST_TYPE,
  NETFLIX_SUBTITLES_RESPONSE_TYPE,
  POST_MESSAGE_TIMEOUT_MS,
} from "@/utils/constants/subtitles"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { OverlaySubtitlesError } from "@/utils/subtitles/errors"
import { getNetflixMovieId } from "@/utils/subtitles/video-id"
import { postMessageRequest } from "../post-message-request"
import { parseNetflixTtml } from "./ttml"

export type NetflixSubtitlesAction = "state" | "load" | "restore" | "cancel"

const netflixSubtitlesResponseSchema = z.object({
  type: z.string(),
  requestId: z.string(),
  movieId: z.number().nullable(),
  trackId: z.string().nullable(),
  translatable: z.boolean(),
  ttml: z.string().nullable(),
})

export type NetflixSubtitlesResponse = z.infer<typeof netflixSubtitlesResponseSchema>

/** `scope` names the request and the video it is for, so the page can refuse a stale one. */
async function requestNetflixSubtitles(
  action: NetflixSubtitlesAction,
  scope: { operationId?: string; operationIds?: string[]; expectedMovieId?: string | null } = {},
): Promise<NetflixSubtitlesResponse | null> {
  const response = await postMessageRequest(
    NETFLIX_SUBTITLES_RESPONSE_TYPE,
    { type: NETFLIX_SUBTITLES_REQUEST_TYPE, action, ...scope },
    action === "load" ? NETFLIX_LOAD_POST_MESSAGE_TIMEOUT_MS : POST_MESSAGE_TIMEOUT_MS,
  )
  const parsed = netflixSubtitlesResponseSchema.safeParse(response)
  return parsed.success ? parsed.data : null
}

export class NetflixSubtitlesFetcher implements SubtitlesFetcher {
  private subtitles: SubtitlesFragment[] = []
  private sourceLanguage = ""
  // What the latest load found, even one that ended without subtitles.
  private lastLoad: { movieId: number | null; trackId: string | null } | null = null
  private confirmedTrack: { movieId: number | null; trackId: string | null } | null = null
  private loadsInFlight = 0
  // Loads still waiting on the page: cleanup gives them up, and the page then changes nothing.
  private pendingOperations = new Set<{ id: string; cancelled: boolean }>()
  // Every load this fetcher has made. A track one of them changed is put back by a restore that
  // names it, or reclaimed when cleanup gives it up; no other fetcher's record is touched.
  private issuedOperationIds = new Set<string>()

  async fetch(): Promise<SubtitlesFragment[]> {
    this.confirmedTrack = null
    const operation = { id: getRandomUUID(), cancelled: false }
    const expectedMovieId = getNetflixMovieId()
    let response: NetflixSubtitlesResponse | null
    this.loadsInFlight++
    this.pendingOperations.add(operation)
    this.issuedOperationIds.add(operation.id)
    try {
      response = await requestNetflixSubtitles("load", {
        operationId: operation.id,
        expectedMovieId,
      })
    } finally {
      this.loadsInFlight--
      this.pendingOperations.delete(operation)
    }
    // Given up, or for a video that is no longer showing: nothing of it is wanted, and the page
    // has changed nothing for it.
    if (operation.cancelled || getNetflixMovieId() !== expectedMovieId) {
      throw new DOMException("Subtitle load superseded", "AbortError")
    }

    const found = { movieId: response?.movieId ?? null, trackId: response?.trackId ?? null }
    this.confirmedTrack = response?.translatable ? found : null
    if (
      this.subtitles.length > 0 &&
      found.movieId === this.lastLoad?.movieId &&
      found.trackId === this.lastLoad.trackId
    ) {
      return this.subtitles
    }
    // Recorded before the checks below, so the track poll also compares with a load that failed.
    this.lastLoad = found
    this.subtitles = []
    this.sourceLanguage = ""

    // No reply, or a player that never became ready: either way the wait ran out.
    if (!response || response.movieId === null) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.fetchSubTimeout"))
    }
    if (!response.translatable) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.noSubtitlesFound"))
    }
    // The video has a usable track, but its subtitle file never reached the page script.
    if (!response.ttml) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.trackFileNotLoaded"))
    }

    const parsed = parseNetflixTtml(response.ttml)
    if (!parsed.fragments.length) {
      throw new OverlaySubtitlesError(i18n.t("subtitles.errors.noSubtitlesFound"))
    }

    this.subtitles = parsed.fragments
    this.sourceLanguage = parsed.language
    return this.subtitles
  }

  getSourceLanguage(): string {
    return this.sourceLanguage
  }

  getCachedSubtitles(): SubtitlesFragment[] | null {
    return this.loadsInFlight === 0 &&
      this.subtitles.length > 0 &&
      this.confirmedTrack !== null &&
      this.confirmedTrack.movieId === this.lastLoad?.movieId &&
      this.confirmedTrack.trackId === this.lastLoad?.trackId
      ? this.subtitles
      : null
  }

  isPreSegmented(): boolean {
    return true
  }

  async hasAvailableSubtitles(): Promise<boolean> {
    return true
  }

  // Netflix's track poll asks this every second, so only a change on the page should start a load.
  async shouldUseSameTrack(): Promise<boolean> {
    // Backoff can be true without confirming that cached text is publishable.
    this.confirmedTrack = null
    // Starting another load now would only throw away the one still running.
    if (this.loadsInFlight > 0) {
      return true
    }
    const lastLoad = this.lastLoad
    if (!lastLoad) {
      return false
    }
    const response = await requestNetflixSubtitles("state")
    this.confirmedTrack = response?.translatable
      ? { movieId: response.movieId, trackId: response.trackId }
      : null
    if (!response) {
      return true
    }
    // A failed load counts too: the same failure is not retried every second, but a new episode,
    // a new track, or a player that is finally ready still reloads.
    if (response.movieId !== lastLoad.movieId) {
      return false
    }
    return !response.translatable || response.trackId === lastLoad.trackId
  }

  // Named for the movie showing now and for the loads of this fetcher: the page acts only on a
  // record one of them made, for a player showing that movie, and spends no other record.
  showNativeSubtitles(): void {
    void requestNetflixSubtitles("restore", {
      expectedMovieId: getNetflixMovieId(),
      operationIds: [...this.issuedOperationIds],
    })
  }

  cleanup(): void {
    // Every load is given up, finished or not: the page refuses what is queued for it, and puts
    // back a track it already changed while the player still shows that movie.
    for (const operation of this.pendingOperations) operation.cancelled = true
    for (const operationId of this.issuedOperationIds) {
      void requestNetflixSubtitles("cancel", { operationId })
    }
    this.pendingOperations.clear()
    this.issuedOperationIds.clear()
    this.subtitles = []
    this.sourceLanguage = ""
    this.lastLoad = null
    this.confirmedTrack = null
  }
}
