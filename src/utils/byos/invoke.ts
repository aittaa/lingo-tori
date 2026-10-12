import type { ByosInvocation } from "./service"
import { sendByosMessage } from "./messages"
type Invoker = (payload: ByosInvocation, signal?: AbortSignal) => Promise<{ text: string }>
let backgroundInvoker: Invoker | undefined
export function installByosBackgroundInvoker(invoke: Invoker) {
  backgroundInvoker = invoke
}
export async function invokeByos(payload: ByosInvocation, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (backgroundInvoker) return backgroundInvoker(payload, signal)
  const requestId = crypto.randomUUID()
  const cancel = () => {
    void sendByosMessage("lingotoriByosCancel", requestId).catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    const result = await sendByosMessage("lingotoriByosInvoke", { requestId, payload })
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}
