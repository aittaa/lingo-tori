import { assertByosSender } from "./service"
interface JobSender {
  id?: string
  url?: string
  tab?: { id?: number }
  frameId?: number
  documentId?: string
}
export function createByosJobRegistry(extensionId: string) {
  const jobs = new Map<string, AbortController>()
  const cancelled = new Set<string>()
  const keyFor = (sender: JobSender, requestId: string) => {
    assertByosSender(sender, extensionId)
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid BYOS request ID")
    return JSON.stringify([
      sender.id,
      sender.tab?.id,
      sender.frameId,
      sender.documentId
        ? ["document", sender.documentId]
        : ["origin", sender.url ? new URL(sender.url).origin : ""],
      requestId,
    ])
  }
  return {
    cancel(sender: JobSender, requestId: string) {
      const key = keyFor(sender, requestId)
      const job = jobs.get(key)
      if (job) job.abort()
      else if (cancelled.size < 100) {
        cancelled.add(key)
        setTimeout(() => cancelled.delete(key), 60000)
      }
    },
    async invoke<T>(
      sender: JobSender,
      requestId: string,
      operation: (signal: AbortSignal) => Promise<T>,
    ) {
      const key = keyFor(sender, requestId)
      if (jobs.has(key)) throw new Error("Duplicate BYOS request")
      if (cancelled.delete(key)) throw new Error("BYOS request cancelled")
      const controller = new AbortController()
      jobs.set(key, controller)
      try {
        return await operation(controller.signal)
      } finally {
        jobs.delete(key)
      }
    },
  }
}
