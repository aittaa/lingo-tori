import type { SegmentationPipeline } from "./segmentation-pipeline"
import type { Config } from "@/types/config/config"
import type {
  SubtitlesRequestOwner,
  SubtitlesVideoContext,
} from "@/utils/subtitles/processor/translator"
import type { SubtitlesFragment, SubtitlesState } from "@/utils/subtitles/types"
import { getLocalConfig } from "@/utils/config/storage"
import { TRANSLATE_LOOK_AHEAD_MS, TRANSLATION_BATCH_SIZE } from "@/utils/constants/subtitles"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import { effectiveLookAheadMs } from "@/utils/subtitles/lookahead"
import { translateSubtitles } from "@/utils/subtitles/processor/translator"
import { adPlayingAtom, subtitlesStore } from "./atoms"

export interface TranslationCoordinatorOptions {
  getFragments: () => SubtitlesFragment[]
  getVideoElement: () => HTMLVideoElement | null
  getCurrentState: () => SubtitlesState
  segmentationPipeline: SegmentationPipeline | null
  onTranslated: (fragments: SubtitlesFragment[]) => void
  onStateChange: (state: SubtitlesState, data?: Record<string, string>) => void
  /**
   * The language the session was built for. Every batch is translated into it, so the session's
   * cues all match the language it is resumed for, whatever the setting says by then.
   */
  targetCode?: Config["language"]["targetCode"]
}

let runCounter = 0

/**
 * A fresh identity for one run. A correlation key, not secret: the background scopes a request by
 * tab id plus this, so the random part keeps runs of different frames of one tab apart, and a run
 * that follows another never shares its identity (ending the old one cannot touch the new one).
 */
function createRunOwnerId(): string {
  runCounter += 1
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${runCounter}`
}

function fragmentIdentity(fragment: Pick<SubtitlesFragment, "end" | "text">): string {
  return `${fragment.end}\0${fragment.text}`
}

export class TranslationCoordinator {
  private translatingStarts = new Set<number>()
  private translatedStarts = new Set<number>()
  private failedStarts = new Set<number>()
  /** Identity of the cue (end+text) associated with a booked start. */
  private knownIdentities = new Map<number, string>()
  private isTranslating = false
  /** False after stop(); blocks chained ticks and in-flight result application. */
  private active = false
  /** Bumped on stop() so in-flight batches cannot apply after stop/start. */
  private runId = 0
  /**
   * The identity the background knows this run by, from start() to stop()/reset(). Every request of
   * the run carries it, so ending the run can drain them (queued, in flight, backing off) instead of
   * only ignoring their answers.
   */
  private ownerId: string | null = null
  private lastEmittedState: SubtitlesState = "idle"
  private videoContext: SubtitlesVideoContext = { videoTitle: "", subtitlesTextContent: "" }
  private listenersAttached = false

  private getFragments: () => SubtitlesFragment[]
  private getVideoElement: () => HTMLVideoElement | null
  private getCurrentState: () => SubtitlesState
  private segmentationPipeline: SegmentationPipeline | null
  private onTranslated: (fragments: SubtitlesFragment[]) => void
  private onStateChange: (state: SubtitlesState, data?: Record<string, string>) => void
  private targetCode: Config["language"]["targetCode"] | undefined

  constructor(options: TranslationCoordinatorOptions) {
    this.getFragments = options.getFragments
    this.getVideoElement = options.getVideoElement
    this.getCurrentState = options.getCurrentState
    this.segmentationPipeline = options.segmentationPipeline
    this.onTranslated = options.onTranslated
    this.onStateChange = options.onStateChange
    this.targetCode = options.targetCode
  }

  start(videoContext?: SubtitlesVideoContext) {
    if (videoContext !== undefined) {
      this.videoContext = videoContext
    }

    const video = this.getVideoElement()
    if (!video) return

    this.active = true
    // A start on a run that is already going keeps its owner: replacing it would leave the
    // requests already sent with an identity nothing will ever end.
    this.ownerId ??= createRunOwnerId()
    this.attachVideoListeners(video)

    if (this.segmentationPipeline) {
      this.segmentationPipeline.start()
    }

    this.handleTranslationTick()
  }

  stop() {
    this.active = false
    this.runId += 1
    // Allow a subsequent start() to translate immediately; the in-flight batch is
    // invalidated by runId and must not leave locks stuck.
    this.isTranslating = false
    this.translatingStarts.clear()
    this.detachVideoListeners()
    this.segmentationPipeline?.stop()
    this.endRun()
  }

  /**
   * Ends the run's requests in the background. Fire and forget: the DOM side of stopping is
   * already done, and a worker that restarted has no queue left to drain.
   */
  private endRun() {
    const ownerId = this.ownerId
    if (ownerId === null) return
    this.ownerId = null
    void sendMessage("cancelSubtitlesTranslateRequests", { ownerId }).catch((error) =>
      logger.warn("Failed to cancel pending subtitle requests", error),
    )
  }

  /** Kick a nearby pass without waiting for the next timeupdate (e.g. after an ad). */
  requestTick() {
    if (!this.active) return
    this.handleTranslationTick()
  }

  reset() {
    this.active = false
    this.runId += 1
    this.detachVideoListeners()
    this.translatingStarts.clear()
    this.translatedStarts.clear()
    this.failedStarts.clear()
    this.knownIdentities.clear()
    this.isTranslating = false
    this.lastEmittedState = "idle"
    this.videoContext = { videoTitle: "", subtitlesTextContent: "" }
    this.endRun()
  }

  private attachVideoListeners(video: HTMLVideoElement) {
    if (this.listenersAttached) return
    video.addEventListener("timeupdate", this.handleTranslationTick)
    video.addEventListener("seeked", this.handleTranslationTick)
    if (this.segmentationPipeline) {
      video.addEventListener("seeked", this.handleSeek)
    }
    this.listenersAttached = true
  }

  private detachVideoListeners() {
    if (!this.listenersAttached) return
    const video = this.getVideoElement()
    if (video) {
      video.removeEventListener("timeupdate", this.handleTranslationTick)
      video.removeEventListener("seeked", this.handleTranslationTick)
      video.removeEventListener("seeked", this.handleSeek)
    }
    this.listenersAttached = false
  }

  clearFailed() {
    this.failedStarts.clear()
  }

  /**
   * Drop bookkeeping for starts that no longer exist, or whose cue identity
   * (end+text) changed after AI re-segmentation — same start can be a recut line.
   */
  noteFragmentListChanged() {
    if (!this.active) return

    const byStart = new Map(this.getFragments().map((fragment) => [fragment.start, fragment]))

    this.invalidateStaleStarts(this.translatedStarts, byStart)
    this.invalidateStaleStarts(this.translatingStarts, byStart)
    this.invalidateStaleStarts(this.failedStarts, byStart)

    this.handleTranslationTick()
  }

  private invalidateStaleStarts(starts: Set<number>, byStart: Map<number, SubtitlesFragment>) {
    for (const start of [...starts]) {
      const current = byStart.get(start)
      if (!current) {
        starts.delete(start)
        this.knownIdentities.delete(start)
        continue
      }

      const known = this.knownIdentities.get(start)
      if (known !== undefined && known !== fragmentIdentity(current)) {
        starts.delete(start)
        this.knownIdentities.delete(start)
      }
    }
  }

  private rememberIdentity(fragment: SubtitlesFragment) {
    this.knownIdentities.set(fragment.start, fragmentIdentity(fragment))
  }

  private handleTranslationTick = () => {
    if (!this.active) return
    // Ad timeline can freeze or jump; do not translate against main-video cues mid-ad.
    if (subtitlesStore.get(adPlayingAtom)) return

    const video = this.getVideoElement()
    if (!video) return

    const currentTimeMs = video.currentTime * 1000
    const fragments = this.getFragments()

    if (this.getCurrentState() === "error") return

    this.updateLoadingStateAt(currentTimeMs, fragments)

    if (
      this.segmentationPipeline &&
      !this.segmentationPipeline.isRunning &&
      this.segmentationPipeline.hasUnprocessedChunks()
    ) {
      this.segmentationPipeline.restart()
    }

    if (this.isTranslating) return
    void this.translateNearby(currentTimeMs)
  }

  private async translateNearby(currentTimeMs: number) {
    if (!this.active) return

    const fragments = this.getFragments()

    const lookAheadMs = effectiveLookAheadMs(
      TRANSLATE_LOOK_AHEAD_MS,
      this.getVideoElement()?.playbackRate,
    )

    const batch = fragments
      .filter(
        (f) =>
          !this.translatedStarts.has(f.start) &&
          !this.translatingStarts.has(f.start) &&
          !this.failedStarts.has(f.start) &&
          f.start >= currentTimeMs - 5000 &&
          f.start <= currentTimeMs + lookAheadMs,
      )
      .slice(0, TRANSLATION_BATCH_SIZE)

    if (batch.length === 0) {
      return
    }

    const runId = this.runId
    const ownerId = this.ownerId
    const owner: SubtitlesRequestOwner | undefined =
      ownerId === null ? undefined : { id: ownerId, isCurrent: () => this.ownerId === ownerId }
    this.isTranslating = true
    batch.forEach((f) => {
      this.translatingStarts.add(f.start)
      this.rememberIdentity(f)
    })

    try {
      const translated = await translateSubtitles(
        batch,
        this.videoContext,
        undefined,
        this.targetCode,
        owner,
      )
      // A newer generation owns the bookkeeping now; stop()/reset() already cleared this one's.
      if (!this.active || runId !== this.runId) return

      // Only accept results whose cue identity still matches the current fragment list.
      const stillValid = this.filterIdentityValid(translated)
      // A cue the translator returned without a translation failed: it is not complete. It counts
      // as resolved (loading clears) and is retried only once clearFailed() runs, never by the
      // next tick. It is shown settled and empty, as the all-failed path shows it, so the player
      // does not read it as a translation still on its way; a retry fills it in.
      const succeeded = stillValid.filter((f) => f.translation !== undefined)
      const failed = stillValid.filter((f) => f.translation === undefined)

      succeeded.forEach((f) => {
        this.translatedStarts.add(f.start)
        this.rememberIdentity(f)
      })
      failed.forEach((f) => {
        this.failedStarts.add(f.start)
        this.rememberIdentity(f)
      })
      // Starts that disappeared or were recut mid-request should not stay "translating".
      batch.forEach((f) => {
        this.translatingStarts.delete(f.start)
      })
      this.onTranslated([...succeeded, ...failed.map((f) => ({ ...f, translation: "" }))])

      const latestTimeMs = this.getCurrentVideoTimeMs(currentTimeMs)
      const latestFragments = this.getFragments()
      this.updateLoadingStateAt(latestTimeMs, latestFragments)
    } catch (error) {
      if (!this.active || runId !== this.runId) return

      // Starts that disappeared or were recut mid-request should not stay "translating".
      batch.forEach((f) => {
        this.translatingStarts.delete(f.start)
      })

      // Same identity gate as the success path: never bookkeep or publish recut/stale cues.
      const stillValid = this.filterIdentityValid(batch)
      stillValid.forEach((f) => {
        this.failedStarts.add(f.start)
        this.rememberIdentity(f)
      })

      const config = await getLocalConfig()
      if (!this.active || runId !== this.runId) {
        return
      }

      // Re-check after the await: AI recut may have landed while config was loading.
      const validForFallback = this.filterIdentityValid(stillValid)
      const displayMode = config?.videoSubtitles?.style.displayMode
      const fallback =
        displayMode === "translationOnly"
          ? validForFallback.map((f) => ({ ...f, translation: f.text }))
          : validForFallback.map((f) => ({ ...f, translation: "" }))
      if (fallback.length > 0) {
        this.onTranslated(fallback)
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      this.lastEmittedState = "error"
      this.onStateChange("error", { message: errorMessage })
    } finally {
      // Only the current generation may clear the lock / chain another tick.
      if (runId === this.runId) {
        this.isTranslating = false
        if (this.active) {
          this.handleTranslationTick()
        }
      }
    }
  }

  private getCurrentVideoTimeMs(fallbackTimeMs: number): number {
    const video = this.getVideoElement()
    if (!video) {
      return fallbackTimeMs
    }
    return video.currentTime * 1000
  }

  /** Keep only cues whose start+end+text still match the live fragment list. */
  private filterIdentityValid(fragments: SubtitlesFragment[]): SubtitlesFragment[] {
    const byStart = new Map(this.getFragments().map((fragment) => [fragment.start, fragment]))
    return fragments.filter((fragment) => {
      const current = byStart.get(fragment.start)
      return !!current && current.end === fragment.end && current.text === fragment.text
    })
  }

  private findActiveCue(timeMs: number, fragments: SubtitlesFragment[]): SubtitlesFragment | null {
    return fragments.find((f) => f.start <= timeMs && f.end > timeMs) ?? null
  }

  private isCueResolved(startMs: number): boolean {
    return this.translatedStarts.has(startMs) || this.failedStarts.has(startMs)
  }

  private updateLoadingStateAt(timeMs: number, fragments: SubtitlesFragment[]) {
    const activeCue = this.findActiveCue(timeMs, fragments)

    if (activeCue) {
      const nextState: SubtitlesState = this.isCueResolved(activeCue.start) ? "idle" : "loading"
      if (nextState === this.lastEmittedState) return
      this.lastEmittedState = nextState
      this.onStateChange(nextState)
      return
    }

    // Gap / music intro / before first cue: never keep the corner loading badge up.
    // Adapter may have set "loading" before fragments were ready; lastEmittedState can
    // still be "idle" while the scheduler state remains "loading" — always clear it.
    if (this.lastEmittedState === "idle" && this.getCurrentState() !== "loading") {
      return
    }
    this.lastEmittedState = "idle"
    this.onStateChange("idle")
  }

  private handleSeek = () => {
    this.segmentationPipeline?.restart()
  }
}
