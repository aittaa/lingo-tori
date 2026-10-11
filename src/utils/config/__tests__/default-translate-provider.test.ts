import { expect, it, vi } from "vitest"
import { selectFreshTranslateProviders } from "../default-translate-provider"
it("does not contact any service on a fresh install", async () => {
  const fetch = vi.fn<(...args: unknown[]) => unknown>()
  vi.stubGlobal("fetch", fetch)
  try {
    await selectFreshTranslateProviders()
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})
