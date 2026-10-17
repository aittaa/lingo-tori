import type { ByosInvocation, ByosInvocationResult } from "./service"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { ConsentRuntimeOptions } from "@/utils/firefox-data-consent"
import { sendByosMessage } from "./messages"
type Invoker = (
  payload: ByosInvocation,
  signal?: AbortSignal,
  usageFeature?: ApiUsageFeature,
  runtime?: ConsentRuntimeOptions,
) => Promise<ByosInvocationResult>
let backgroundInvoker: Invoker | undefined
export function installByosBackgroundInvoker(invoke: Invoker) {
  backgroundInvoker = invoke
}
export async function invokeByos(
  payload: ByosInvocation,
  signal?: AbortSignal,
  usageFeature?: ApiUsageFeature,
  runtime?: ConsentRuntimeOptions,
) {
  signal?.throwIfAborted()
  if (backgroundInvoker) return backgroundInvoker(payload, signal, usageFeature, runtime)
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
      dataCategories: runtime?.dataCategories ? [...runtime.dataCategories] : undefined,
    })
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}
