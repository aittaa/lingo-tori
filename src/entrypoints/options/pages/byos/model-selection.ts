export function reconcileModelSelection(
  models: ReadonlyArray<{ slug: string }>,
  current: string,
  saved: string | null | undefined,
): string {
  for (const candidate of [current, saved]) {
    if (candidate && models.some((model) => model.slug === candidate)) return candidate
  }
  return models[0]?.slug ?? ""
}
