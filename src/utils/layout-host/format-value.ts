/** Format model data as plain text only. Strings are never parsed as markup. */
export function formatResultValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2) ?? "—"
    } catch {
      // A malformed/cyclic response must not take down the selection popover.
      return "—"
    }
  }
  return "—"
}
