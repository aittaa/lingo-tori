import type { CopyTranslatedSubtitlesMessageTone } from "./copy-translated-subtitles.constants"
import { useAtomValue } from "jotai"
import { useEffect, useState } from "react"
import { SubtitleCopyPhase, translatedSubtitlesCopyStatusAtom } from "../../../atoms"
import { subtitleCopyMessage } from "../../../subtitle-copy-messages"
import { useSubtitlesUI } from "../../subtitles-ui-context"
import {
  COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE,
  COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS,
} from "./copy-translated-subtitles.constants"

function getMessageTone(
  phase: SubtitleCopyPhase,
  message: string | null,
): CopyTranslatedSubtitlesMessageTone | null {
  if (phase === SubtitleCopyPhase.Complete) {
    return COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE.Success
  }

  return message !== null ? COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE.Muted : null
}

export function useCopyTranslatedSubtitles() {
  const status = useAtomValue(translatedSubtitlesCopyStatusAtom)
  const { copyTranslatedSubtitles } = useSubtitlesUI()
  const [showPreparingMessage, setShowPreparingMessage] = useState(false)
  const shouldShowPreparingMessageAfterDelay =
    status.phase === SubtitleCopyPhase.Checking || status.phase === SubtitleCopyPhase.Preparing

  useEffect(() => {
    if (!shouldShowPreparingMessageAfterDelay) {
      // eslint-disable-next-line react/set-state-in-effect
      setShowPreparingMessage(false)
      return undefined
    }

    const timeoutId = setTimeout(
      setShowPreparingMessage,
      COPY_TRANSLATED_SUBTITLES_PREPARING_MESSAGE_DELAY_MS,
      true,
    )
    return () => clearTimeout(timeoutId)
  }, [shouldShowPreparingMessageAfterDelay])

  const preparingMessage = showPreparingMessage ? subtitleCopyMessage("copyPreparing") : null

  const message = {
    [SubtitleCopyPhase.Preparing]: preparingMessage,
    [SubtitleCopyPhase.Translating]: subtitleCopyMessage("copyTranslating"),
    [SubtitleCopyPhase.Complete]: subtitleCopyMessage("copyComplete"),
    [SubtitleCopyPhase.Ready]: subtitleCopyMessage("copyReady"),
    [SubtitleCopyPhase.Copying]: null,
    [SubtitleCopyPhase.CopyFailed]: subtitleCopyMessage("copyFailed"),
    [SubtitleCopyPhase.Idle]: null,
    [SubtitleCopyPhase.Checking]: preparingMessage,
  }[status.phase]
  const messageTone = getMessageTone(status.phase, message)
  const isRunning =
    status.phase === SubtitleCopyPhase.Preparing ||
    status.phase === SubtitleCopyPhase.Translating ||
    status.phase === SubtitleCopyPhase.Checking ||
    status.phase === SubtitleCopyPhase.Copying

  return {
    message,
    messageTone,
    progress: status.phase === SubtitleCopyPhase.Translating ? status.progress : null,
    isRunning,
    copy: copyTranslatedSubtitles,
    retry: status.phase === SubtitleCopyPhase.CopyFailed,
  }
}
