import { useQuery } from "@tanstack/react-query"
import { getUiLocale } from "@/utils/i18n"
import { learningCopy, learningLocale } from "@/utils/learning/copy"
import { sendLearningMessage } from "@/utils/learning/messages"
export function ReviewDueTab({ source: _source }: { source?: string }) {
  const copy = learningCopy[learningLocale(getUiLocale())]
  const { data } = useQuery({
    queryKey: ["lingotori", "counts"],
    queryFn: () => sendLearningMessage("lingotoriCounts", undefined),
    refetchInterval: 15000,
    retry: false,
  })
  return (
    <button
      type="button"
      className="self-end rounded px-3 py-1 text-xs hover:bg-muted"
      onClick={() => {
        void sendLearningMessage("lingotoriOpenStudy", undefined)
      }}
    >
      {copy.open}
      {data ? ` · ${data.due} ${copy.due}` : ""}
    </button>
  )
}
