import type { ByosInvocation } from "./service"
import type { ApiUsageFeature } from "@/utils/api-usage"
import { sendByosMessage } from "./messages"
type Invoker = (
  payload: ByosInvocation,
  signal?: AbortSignal,
  usageFeature?: ApiUsageFeature,
) => Promise<{ text: string }>
let backgroundInvoker: Invoker | undefined
export function installByosBackgroundInvoker(invoke: Invoker) {
  backgroundInvoker = invoke
}
export async function invokeByos(
  payload: ByosInvocation,
  signal?: AbortSignal,
  usageFeature?: ApiUsageFeature,
) {
  signal?.throwIfAborted()
  if (backgroundInvoker) return backgroundInvoker(payload, signal, usageFeature)
  const requestId = crypto.randomUUID()
  const cancel = () => {
    void sendByosMessage("lingotoriByosCancel", requestId).catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    const result = await sendByosMessage("lingotoriByosInvoke", {
      requestId,
      payload,
      usageFeature,
    })
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}
