import { IconCopy, IconLanguage, IconLoader2 } from "@tabler/icons-react"
import { cva } from "class-variance-authority"
import { Button } from "@/components/ui/base-ui/button"
import { cn } from "@/utils/styles/utils"
import { subtitleCopyMessage } from "../../../subtitle-copy-messages"
import { COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE } from "./copy-translated-subtitles.constants"
import { SubtitlesSettingsItem } from "./subtitles-settings-item"
import { useCopyTranslatedSubtitles } from "./use-copy-translated-subtitles"

const copyTranslatedSubtitlesMessageVariants = cva(
  "text-xs leading-4 drop-shadow-[0_1px_1px_rgba(0,0,0,0.85)]",
  {
    variants: {
      tone: {
        [COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE.Muted]: "text-muted-foreground",
        [COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE.Success]: "text-success",
      },
    },
    defaultVariants: {
      tone: COPY_TRANSLATED_SUBTITLES_MESSAGE_TONE.Muted,
    },
  },
)

export function CopyTranslatedSubtitles() {
  const { message, messageTone, progress, isRunning, copy, retry } = useCopyTranslatedSubtitles()
  const buttonId = "read-frog-copy-translated-subtitles"
  const title = subtitleCopyMessage("copyTranslated")

  return (
    <SubtitlesSettingsItem
      icon={<IconLanguage className="size-3.5" />}
      label={
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{title}</span>
          {message && (
            <span
              className={cn(
                copyTranslatedSubtitlesMessageVariants({ tone: messageTone }),
                isRunning && "shimmer",
              )}
              aria-live="polite"
            >
              {message}
              {progress !== null && (
                <>
                  {" "}
                  ({progress}
                  %)
                </>
              )}
            </span>
          )}
        </div>
      }
      labelFor={buttonId}
    >
      <Button
        id={buttonId}
        type="button"
        variant="ghost-secondary"
        size="icon-sm"
        onClick={copy}
        aria-label={retry ? subtitleCopyMessage("copyRetry") : title}
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
