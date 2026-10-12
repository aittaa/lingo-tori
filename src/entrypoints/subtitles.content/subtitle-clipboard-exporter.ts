import { toastManager } from "@/components/ui/base-ui/toast"
import { i18n } from "@/utils/i18n"
import { copySubtitlesText } from "@/utils/subtitles/srt"
import { SubtitleCopyPhase } from "./atoms"
import { subtitleCopyMessage } from "./subtitle-copy-messages"

type CopyStatus = { phase: SubtitleCopyPhase; progress: number | null }

/** Prepare first; copy only on a subsequent user gesture. No clipboard permission added. */
export class SubtitleClipboardExporter {
  private preparedText: string | null = null
  private preparedContext: unknown
  private operationId = 0
  private isRunning = false
  private successTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    private prepare: (assertActive: () => void) => Promise<string>,
    private setStatus: (status: CopyStatus) => void,
    private getContext: () => unknown,
  ) {}

  run = async (): Promise<void> => {
    if (this.isRunning) return
    this.clearSuccessTimeout()
    const context = this.getContext()
    if (context !== this.preparedContext) this.preparedText = null
    const operationId = ++this.operationId
    const isActive = () => operationId === this.operationId && context === this.getContext()
    const assertActive = () => {
      if (!isActive()) throw new DOMException("Subtitle export superseded", "AbortError")
    }
    this.isRunning = true
    const isCopy = this.preparedText !== null

    try {
      if (isCopy) {
        this.setStatus({ phase: SubtitleCopyPhase.Copying, progress: null })
        // This runs synchronously in the second click, before the first await.
        await copySubtitlesText(this.preparedText!)
        assertActive()
        this.setStatus({ phase: SubtitleCopyPhase.Complete, progress: null })
        this.successTimeout = setTimeout(() => {
          this.successTimeout = null
          if (isActive()) this.setStatus({ phase: SubtitleCopyPhase.Ready, progress: null })
        }, 4000)
      } else {
        this.setStatus({ phase: SubtitleCopyPhase.Checking, progress: null })
        const text = await this.prepare(assertActive)
        assertActive()
        if (!text.trim()) throw new Error(i18n.t("subtitles.errors.noSubtitlesFound"))
        this.preparedText = text
        this.preparedContext = context
        this.setStatus({ phase: SubtitleCopyPhase.Ready, progress: null })
      }
    } catch (error) {
      if (!isActive()) return
      if (isCopy) {
        this.setStatus({ phase: SubtitleCopyPhase.CopyFailed, progress: null })
        toastManager.add({
          type: "error",
          title: subtitleCopyMessage(
            typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function"
              ? "copyUnavailable"
              : "copyFailed",
          ),
        })
      } else {
        this.setStatus({ phase: SubtitleCopyPhase.Idle, progress: null })
        toastManager.add({
          type: "error",
          title: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (operationId === this.operationId) {
        this.isRunning = false
        // A context change can precede the navigation listener. Discard stale data now.
        if (!isActive()) this.dispose()
      }
    }
  }

  dispose(): void {
    this.operationId++
    this.isRunning = false
    this.preparedText = null
    this.preparedContext = undefined
    this.clearSuccessTimeout()
    this.setStatus({ phase: SubtitleCopyPhase.Idle, progress: null })
  }

  private clearSuccessTimeout(): void {
    if (this.successTimeout !== null) {
      clearTimeout(this.successTimeout)
      this.successTimeout = null
    }
  }
}
