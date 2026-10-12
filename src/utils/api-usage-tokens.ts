export interface ReportedTokens {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
}

export function reportedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Optional numeric metadata only. Malformed/absent usage never rejects an inference. */
export function readResponsesTokens(value: unknown): ReportedTokens | undefined {
  const usage = object(value)
  const input = object(usage.input_tokens_details)
  const output = object(usage.output_tokens_details)
  const tokens: ReportedTokens = {
    inputTokens: reportedTokenCount(usage.input_tokens),
    outputTokens: reportedTokenCount(usage.output_tokens),
    cachedInputTokens: reportedTokenCount(input.cached_tokens),
    cacheWriteInputTokens: reportedTokenCount(input.cache_write_tokens),
    reasoningTokens: reportedTokenCount(output.reasoning_tokens),
  }
  return tokens.inputTokens === undefined && tokens.outputTokens === undefined ? undefined : tokens
}

const inputKeys = [
  "input_tokens",
  "prompt_tokens",
  "promptTokenCount",
  "inputTokens",
  "inputTokenCount",
  "prompt_eval_count",
]
const outputKeys = [
  "output_tokens",
  "completion_tokens",
  "candidatesTokenCount",
  "outputTokens",
  "outputTokenCount",
  "eval_count",
]
function explicitlyReported(raw: unknown, keys: string[]): boolean {
  const value = object(raw)
  return (
    keys.some((key) => reportedTokenCount(value[key]) !== undefined) ||
    ["usage", "tokens"].some((key) =>
      keys.some((field) => reportedTokenCount(object(value[key])[field]) !== undefined),
    )
  )
}

/** SDK totals are provider-normalized and already include cache/reasoning where applicable.
 * Do not turn an adapter's missing-field fallback zero into a measured zero. */
export function readSdkTokens(value: unknown): ReportedTokens {
  const usage = object(value)
  const input = reportedTokenCount(usage.inputTokens)
  const output = reportedTokenCount(usage.outputTokens)
  return {
    inputTokens: input === 0 && !explicitlyReported(usage.raw, inputKeys) ? undefined : input,
    outputTokens: output === 0 && !explicitlyReported(usage.raw, outputKeys) ? undefined : output,
  }
}
