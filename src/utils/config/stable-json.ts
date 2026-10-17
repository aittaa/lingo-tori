/**
 * JSON text with sorted object keys, for hashing. It follows what storage does to a value: an
 * object property that is `undefined` is dropped, an `undefined` array element and a non-finite
 * number become `null`. Two values that storage would keep as the same data therefore give the same
 * text, whatever order their keys were written in.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "null"
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Array.from(value, (item) => {
      const normalized = normalize(item)
      return normalized === undefined ? null : normalized
    })
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const normalized = normalize(source[key])
      if (normalized !== undefined) result[key] = normalized
    }
    return result
  }
  return value
}
