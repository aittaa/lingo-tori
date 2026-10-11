/** Legacy layouts are accepted as inert config data and never returned for execution. */
export function resolveActionLayout(_action: { layout?: string | null }): string {
  return ""
}
