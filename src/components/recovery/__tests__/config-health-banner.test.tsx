// @vitest-environment jsdom
// The banner that tells the user a change was not saved, shared by the options page and the popup.
//
// Real: `ConfigHealthBanner`, the health atoms, `writeConfigAtom` and the settings service, over the
// extension's in-memory browser storage. The tests open the atoms in a fresh module graph so that
// the banner and the writer share one store, as a page does.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  corruptConfig,
  CURRENT_META,
  failWrites,
  PREVIOUS_META,
  previousVersionConfig,
  resetStorage,
  seedPrimary,
  settle,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"

const TITLE_UNUSABLE = "configHealth.unusable.title"
const ACTION = "configHealth.unusable.action"
const TITLE_FAILURE = "configHealth.failure.title"
const DISMISS = "configHealth.failure.dismiss"
const EDIT = { language: { sourceCode: "auto", targetCode: "kor", level: "beginner" } } as const

beforeEach(() => {
  resetStorage()
})

afterEach(() => {
  cleanup()
})

async function renderBanner() {
  vi.resetModules()
  const { ConfigHealthBanner } = await import("../config-health-banner")
  const atoms = await import("@/utils/atoms/config")
  const health = await import("@/utils/atoms/config-health")
  const store = createStore()
  const onOpenRecovery = vi.fn<() => void>()
  render(
    <Provider store={store}>
      <ConfigHealthBanner onOpenRecovery={onOpenRecovery} />
    </Provider>,
  )
  return { store, atoms, health, onOpenRecovery }
}

describe("the banner", () => {
  it("shows nothing while the stored config is usable and no change failed", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    await renderBanner()
    await settle()

    expect(screen.queryByTestId("config-health-banner")).not.toBeInTheDocument()
  })

  it("says the stored config cannot be read, and opens the recovery options", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    const { onOpenRecovery } = await renderBanner()
    await waitFor(() => screen.getByText(TITLE_UNUSABLE))
    fireEvent.click(screen.getByText(ACTION))

    expect(onOpenRecovery).toHaveBeenCalledOnce()
  })

  it("appears when the stored config becomes unusable while the page is open, and goes when it is usable again", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await renderBanner()
    await settle()
    expect(screen.queryByText(TITLE_UNUSABLE)).not.toBeInTheDocument()

    await seedPrimary(corruptConfig(), CURRENT_META)
    await waitFor(() => screen.getByText(TITLE_UNUSABLE))

    await seedPrimary(validConfig(), CURRENT_META)
    await waitFor(() => expect(screen.queryByText(TITLE_UNUSABLE)).not.toBeInTheDocument())
  })

  it("says so when an ordinary change over an unusable config is refused (nothing is dropped silently)", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)
    const { store, atoms } = await renderBanner()
    await waitFor(() => screen.getByText(TITLE_UNUSABLE))

    await expect(store.set(atoms.writeConfigAtom, EDIT)).rejects.toMatchObject({
      name: "ConfigRecoveryRequiredError",
    })

    expect(screen.getByText(TITLE_UNUSABLE)).toBeVisible()
    expect(screen.queryByText(TITLE_FAILURE)).not.toBeInTheDocument()
  })

  it("says a change was not saved when the saving part could not save, and goes with the next one that is", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { store, atoms } = await renderBanner()
    await settle()
    failWrites((keys) => keys.includes("config"))

    await expect(store.set(atoms.writeConfigAtom, EDIT)).rejects.toMatchObject({
      name: "ConfigUnavailableError",
    })
    await waitFor(() => screen.getByText(TITLE_FAILURE))
    expect(screen.getByText("configHealth.failure.unavailable")).toBeVisible()

    vi.restoreAllMocks()
    await store.set(atoms.writeConfigAtom, EDIT)
    await waitFor(() => expect(screen.queryByText(TITLE_FAILURE)).not.toBeInTheDocument())
  })

  it("can be dismissed", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { store, atoms } = await renderBanner()
    await settle()
    failWrites((keys) => keys.includes("config"))
    await store.set(atoms.writeConfigAtom, EDIT).catch(() => undefined)
    await waitFor(() => screen.getByText(TITLE_FAILURE))

    fireEvent.click(screen.getByText(DISMISS))

    expect(screen.queryByText(TITLE_FAILURE)).not.toBeInTheDocument()
  })

  it("puts an unusable stored config before a change that was not saved", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { store, health } = await renderBanner()
    await settle()
    store.set(health.configWriteFailureAtom, { kind: "unavailable" })
    await waitFor(() => screen.getByText(TITLE_FAILURE))

    await seedPrimary(corruptConfig(), CURRENT_META)

    await waitFor(() => screen.getByText(TITLE_UNUSABLE))
    expect(screen.queryByText(TITLE_FAILURE)).not.toBeInTheDocument()
  })

  it("says the stored config cannot be read when a start found that its upgrade failed, with no copy kept", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)
    await renderBanner()
    await settle()
    expect(screen.queryByText(TITLE_UNUSABLE)).not.toBeInTheDocument()

    const { recordInitFailure } = await import("@/utils/config/init-failure")
    const { readRawConfigPair } = await import("@/utils/config/status")
    await recordInitFailure(await readRawConfigPair(), "migration-failed")

    expect(await screen.findByText(TITLE_UNUSABLE)).toBeVisible()
  })

  it("says the stored config cannot be read when its meta has a modified time that is there and undefined", async () => {
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: any[]
    ) => Promise<Record<string, unknown>>
    vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation((async (...args: any[]) => {
      const keys = args[0]
      if (Array.isArray(keys) && keys.includes("config") && keys.includes("config$")) {
        return {
          config: structuredClone(validConfig()),
          config$: { schemaVersion: 111, lastModifiedAt: undefined },
        }
      }
      return realGet(...args)
    }) as any)

    await renderBanner()

    expect(await screen.findByText(TITLE_UNUSABLE)).toBeVisible()
  })
})
