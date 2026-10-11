import { IconCopy, IconLoader2 } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { Button } from "@/components/ui/base-ui/button"
import { sourceSubtitlesCopyStatusAtom, SubtitleCopyPhase } from "../../../atoms"
import { subtitleCopyMessage } from "../../../subtitle-copy-messages"
import { useSubtitlesUI } from "../../subtitles-ui-context"
import { SubtitlesSettingsItem } from "./subtitles-settings-item"

export function CopySourceSubtitles() {
  const { copySourceSubtitles } = useSubtitlesUI()
  const { phase } = useAtomValue(sourceSubtitlesCopyStatusAtom)
  const isRunning = phase === SubtitleCopyPhase.Checking || phase === SubtitleCopyPhase.Copying
  const buttonId = "read-frog-copy-source-subtitles"
  const title = subtitleCopyMessage("copySource")
  const message =
    phase === SubtitleCopyPhase.Ready
      ? subtitleCopyMessage("copyReady")
      : phase === SubtitleCopyPhase.CopyFailed
        ? subtitleCopyMessage("copyFailed")
        : phase === SubtitleCopyPhase.Complete
          ? subtitleCopyMessage("copyComplete")
          : phase === SubtitleCopyPhase.Checking
            ? subtitleCopyMessage("copyPreparing")
            : null

  return (
    <SubtitlesSettingsItem
      icon={<IconCopy className="size-3.5" />}
      labelFor={buttonId}
      label={
        <div className="flex min-w-0 flex-col">
          <span>{title}</span>
          {message && (
            <span
              className={
                phase === SubtitleCopyPhase.Complete
                  ? "text-xs text-success"
                  : "text-xs text-muted-foreground"
              }
              aria-live="polite"
            >
              {message}
            </span>
          )}
        </div>
      }
    >
      <Button
        id={buttonId}
        type="button"
        variant="ghost-secondary"
        size="icon-sm"
        aria-label={
          phase === SubtitleCopyPhase.CopyFailed ? subtitleCopyMessage("copyRetry") : title
        }
        onClick={copySourceSubtitles}
        disabled={isRunning}
      >
        {isRunning ? (
          <IconLoader2 className="size-3.5 animate-spin" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
      </Button>
    </SubtitlesSettingsItem>
  )
}
