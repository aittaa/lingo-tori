// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import { createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { browser } from "#imports"
import {
  committedMeta,
  CURRENT_META,
  holdFirstCall,
  readRawPrimary,
  resetStorage,
  seedPrimary,
} from "@/utils/config/__tests__/preservation-test-kit"
import { getConfigView } from "@/utils/config/status"
import { editConfig } from "@/utils/config/write-guard"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { configAtom, writeConfigAtom } from "../config"
import { patchActionConfigAtom, patchProviderConfigAtom } from "../entity-config"

// The config lives in the in-memory browser storage, and every write goes through the settings
// service (attached by the shared test setup). "Another context changed the settings" is another
// edit committed through the same service, which also fires the storage notification the screens
// listen to. The assertions are those of the earlier version of this file, which modelled storage
// with an in-memory object behind a mocked adapter.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const unsubs: (() => void)[] = []

async function stored(): Promise<Config> {
  return (await readRawPrimary()).value as Config
}

/** A change made by another context: committed through the service like any edit. */
async function external(change: (config: Config) => Config) {
  await editConfig(change)
  await tick()
}

async function mountStore() {
  const store = createStore()
  store.set(configAtom, await stored())
  unsubs.push(store.sub(configAtom, () => {}))
  return store
}

describe("config persistence and invalidation", () => {
  beforeEach(async () => {
    resetStorage()
    const initial = structuredClone(DEFAULT_CONFIG)
    initial.providersConfig.push(structuredClone(DEFAULT_PROVIDER_CONFIG.openai))
    await seedPrimary(initial, CURRENT_META)
  })
  afterEach(() => {
    unsubs.splice(0).forEach((unsubscribe) => unsubscribe())
    fakeBrowser.reset()
  })

  it("re-evaluates a pure updater against fresh storage and preserves unrelated changes", async () => {
    const store = await mountStore()
    await tick()
    const source = (await stored()).providersConfig.find(
      (provider) => provider.provider === "openai",
    )!
    await external((config) => ({
      ...config,
      providersConfig: config.providersConfig.map((provider) =>
        provider.provider === "openai" && provider.id === source.id
          ? { ...provider, description: "external", headers: { old: "value" } }
          : provider,
      ),
    }))
    await store.set(patchProviderConfigAtom, {
      id: source.id,
      changes: { name: "local", headers: undefined },
    })
    const result = (await stored()).providersConfig.find((provider) => provider.id === source.id)
    expect(result).toMatchObject({ name: "local", description: "external" })
    // Cleared with `undefined`: the field is absent in what is stored.
    expect(result).not.toHaveProperty("headers")
    expect(store.get(configAtom)).toEqual(await stored())
  })

  it("preserves concurrent sibling changes and continues after a failed write", async () => {
    const store = await mountStore()
    await tick()
    vi.spyOn(browser.storage.local, "set").mockRejectedValueOnce(new Error("failed write"))
    const first = store.set(writeConfigAtom, { betaExperience: { enabled: true } })
    const failure = first.catch((error: unknown) => error)
    const second = store.set(writeConfigAtom, { uiLanguage: "ko" })
    expect(await failure).toMatchObject({ name: "ConfigUnavailableError" })
    await second
    await tick()
    expect((await stored()).uiLanguage).toBe("ko")
    expect(store.get(configAtom)).toEqual(await stored())
  })

  it("does not let an initial read overwrite a newer local write", async () => {
    const released = deferred<void>()
    const real = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: unknown[]
    ) => Promise<unknown>
    let holding = true
    // Every read of the config that starts while `holding` answers late, with what it found.
    vi.spyOn(fakeBrowser.storage.local, "get" as any).mockImplementation(((...args: unknown[]) => {
      const result = real(...args)
      const keys = args[0]
      if (holding && Array.isArray(keys) && keys.includes("config")) {
        return result.then((value) => released.promise.then(() => value))
      }
      return result
    }) as any)
    const store = await mountStore()
    await tick()
    holding = false
    await store.set(writeConfigAtom, { uiLanguage: "ko" })
    released.resolve()
    await tick()
    expect(store.get(configAtom).uiLanguage).toBe("ko")
  })

  it("treats delayed notifications as invalidation and rereads the latest value", async () => {
    const store = await mountStore()
    await tick()
    await store.set(writeConfigAtom, { uiLanguage: "ko" })
    await store.set(writeConfigAtom, { uiLanguage: "ja" })
    await tick()
    expect(store.get(configAtom).uiLanguage).toBe("ja")
    await external((config) => ({ ...config, uiLanguage: "ko" }))
    await tick()
    expect(store.get(configAtom).uiLanguage).toBe("ko")
  })

  it("does not replace optimistic state while a storage write is pending", async () => {
    const store = await mountStore()
    await tick()
    const commit = holdFirstCall("set", (keys) => keys.includes("config"))
    const write = store.set(writeConfigAtom, { uiLanguage: "ko" })
    await commit.reached
    // A notification arrives while the write is still pending.
    await fakeBrowser.storage.local.set({ unrelated: 1 })
    await tick()
    expect(store.get(configAtom).uiLanguage).toBe("ko")
    commit.release()
    await write
    await tick()
    expect(store.get(configAtom).uiLanguage).toBe("ko")
  })

  it("patches only the edited action fields without replacing siblings or order", async () => {
    const action = {
      id: "a",
      name: "A",
      icon: "tabler:sparkles",
      // Stored configs are validated now, so the action must name a provider that exists.
      providerId: DEFAULT_PROVIDER_CONFIG.openai.id,
      systemPrompt: "",
      prompt: "x",
      outputSchema: [
        {
          id: "result",
          name: "result",
          type: "string" as const,
          description: "Result",
        },
      ],
    }
    await external((config) => ({
      ...config,
      selectionToolbar: {
        ...config.selectionToolbar,
        customActions: [action, { ...action, id: "b", name: "B" }],
      },
    }))
    const store = await mountStore()
    await tick()
    await external((config) => ({
      ...config,
      selectionToolbar: {
        ...config.selectionToolbar,
        customActions: [
          { ...action, id: "b", name: "external B" },
          { ...action, prompt: "external prompt" },
        ],
      },
    }))
    await store.set(patchActionConfigAtom, { id: "a", changes: { name: "local A" } })
    const { customActions } = (await stored()).selectionToolbar
    expect(customActions.map(({ id }) => id)).toEqual(["b", "a"])
    expect(customActions[0]?.name).toBe("external B")
    expect(customActions[1]).toMatchObject({
      name: "local A",
      prompt: "external prompt",
    })
  })

  it("rejects an entity deleted before the queued update instead of recreating it", async () => {
    const store = await mountStore()
    await tick()
    const source = (await stored()).providersConfig.find(
      (provider) => provider.provider === "openai",
    )!
    await external((config) => ({
      ...config,
      providersConfig: config.providersConfig.filter((provider) => provider.id !== source.id),
    }))
    await expect(
      store.set(patchProviderConfigAtom, { id: source.id, changes: { name: "local" } }),
    ).rejects.toThrow("no longer exists")
    expect((await stored()).providersConfig.some((provider) => provider.id === source.id)).toBe(
      false,
    )
  })
})

// What the mounted settings show follows the session view of the stored config (the status reader),
// not the stored value alone: a pair whose meta no longer matches its value is unusable, and the
// screens run on the defaults for it, like every other consumer of the config.
describe("the mounted settings and the status of the stored config", () => {
  let custom: Config

  beforeEach(async () => {
    resetStorage()
    custom = structuredClone(DEFAULT_CONFIG)
    custom.contextMenu.enabled = !DEFAULT_CONFIG.contextMenu.enabled
    await seedPrimary(custom, committedMeta(custom))
  })
  afterEach(() => {
    unsubs.splice(0).forEach((unsubscribe) => unsubscribe())
    fakeBrowser.reset()
  })

  async function tearThePair() {
    const meta = (await readRawPrimary()).meta as Record<string, unknown>
    await browser.storage.local.set({ config$: { ...meta, valueDigest: "not-the-digest" } })
  }

  it("shows the usable config as stored", async () => {
    const store = await mountStore()
    await tick()

    expect(store.get(configAtom)).toEqual(custom)
    expect((await getConfigView()).status.kind).toBe("usable")
  })

  it("switches to the status view when only the meta changes so that the pair is torn", async () => {
    const store = await mountStore()
    await tick()

    await tearThePair()
    await tick()
    await tick()

    const view = await getConfigView()
    expect(view.status).toMatchObject({ kind: "suspect", reason: "incoherent" })
    expect(store.get(configAtom)).toEqual(view.config)
    expect(store.get(configAtom)).toEqual(DEFAULT_CONFIG)
  })

  it("shows the status view on a fresh mount over a torn pair", async () => {
    await tearThePair()

    const store = await mountStore()
    await tick()
    await tick()

    expect(store.get(configAtom)).toEqual((await getConfigView()).config)
    expect(store.get(configAtom)).toEqual(DEFAULT_CONFIG)
  })

  it("shows the status view again when the page becomes visible", async () => {
    await tearThePair()
    const store = await mountStore()
    await tick()
    await tick()
    store.set(configAtom, custom)

    document.dispatchEvent(new Event("visibilitychange"))
    await tick()
    await tick()

    expect(store.get(configAtom)).toEqual(DEFAULT_CONFIG)
  })

  it("returns to the stored config once the pair is coherent again", async () => {
    const store = await mountStore()
    await tick()
    const meta = (await readRawPrimary()).meta as Record<string, unknown>
    await tearThePair()
    await tick()
    await tick()
    expect(store.get(configAtom)).toEqual(DEFAULT_CONFIG)

    await browser.storage.local.set({ config$: meta })
    await tick()
    await tick()

    expect(store.get(configAtom)).toEqual(custom)
  })
})
