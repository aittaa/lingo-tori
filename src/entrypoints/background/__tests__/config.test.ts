import { beforeEach, describe, expect, it, vi } from "vitest"

const { initializeConfigMock } = vi.hoisted(() => ({
  initializeConfigMock: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/config/init", () => ({ initializeConfig: initializeConfigMock }))

describe("background config initialization", () => {
  beforeEach(() => {
    // The memoized initialization lives in module state; every test starts a fresh worker.
    vi.resetModules()
    initializeConfigMock.mockReset()
  })

  it("reports storage as it was found even after startup has already filled in defaults", async () => {
    // `backgroundReady` calls ensureInitializedConfig as soon as the worker starts, before
    // `onInstalled` is dispatched; the first initialization is the one that saw an empty profile.
    initializeConfigMock.mockResolvedValue({ isFreshInstall: true, hadStoredConfig: false })
    const config = await import("../config")

    await config.ensureInitializedConfig()
    const result = await config.getInitializeConfigResult()

    expect(result.hadStoredConfig).toBe(false)
    expect(await config.isFreshInstalledConfig()).toBe(true)
    expect(initializeConfigMock).toHaveBeenCalledOnce()
  })

  it("gives the same answer when onInstalled gets there first", async () => {
    initializeConfigMock.mockResolvedValue({ isFreshInstall: true, hadStoredConfig: false })
    const config = await import("../config")

    const result = await config.getInitializeConfigResult()
    await config.ensureInitializedConfig()

    expect(result.hadStoredConfig).toBe(false)
    expect(initializeConfigMock).toHaveBeenCalledOnce()
  })

  it("keeps an unusable stored config counted as stored, and not as a fresh install", async () => {
    initializeConfigMock.mockResolvedValue({ isFreshInstall: false, hadStoredConfig: true })
    const config = await import("../config")

    await config.ensureInitializedConfig()

    // An unusable config is kept as it is, so the provider probe for fresh installs does not run,
    // and as far as onboarding is concerned this is an existing user.
    expect(await config.isFreshInstalledConfig()).toBe(false)
    expect((await config.getInitializeConfigResult()).hadStoredConfig).toBe(true)
  })

  it("initializes once however many callers ask at the same time", async () => {
    initializeConfigMock.mockResolvedValue({ isFreshInstall: false, hadStoredConfig: true })
    const config = await import("../config")

    await Promise.all([
      config.ensureInitializedConfig(),
      config.isFreshInstalledConfig(),
      config.getInitializeConfigResult(),
    ])

    expect(initializeConfigMock).toHaveBeenCalledOnce()
  })
})
