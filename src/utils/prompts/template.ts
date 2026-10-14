/**
 * The selected prompt exactly as stored, BEFORE any `{{token}}` is filled in.
 *
 * A request carries this instead of the finished prompt on purpose: the target
 * language, page context and glossary terms are resolved where each one belongs
 * (the request's own `langConfig`, its context fields, its terms), and only the
 * choice of WHICH prompt must not move between the moment the cache key is
 * hashed and the moment the background runs the request.
 */
export interface PromptTemplate {
  systemPrompt: string
  prompt: string
}

/**
 * Validate a template that arrived over the message bus.
 *
 * The wire is a trust boundary — an older content script still live across an
 * update sends none — so anything that is not exactly two strings is treated as
 * "no snapshot" and the background resolves the prompt itself, as it always did.
 * The result is rebuilt in a fixed key order so it can be compared and keyed by
 * its JSON.
 */
export function parsePromptTemplate(value: unknown): PromptTemplate | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { systemPrompt, prompt } = value as Record<string, unknown>
  if (typeof systemPrompt !== "string" || typeof prompt !== "string") return undefined
  return { systemPrompt, prompt }
}
