// @vitest-environment jsdom
// The options page's controls while the stored config cannot be used: a refusal is reported by the
// page's own notices, and it must not also reach the page as an uncaught error.
//
// A settings switch starts its write and does not wait for it, so the write's rejection has no
// caller to receive it. "Backup now" waits through a mutation that reports the failure itself. Both
// are driven by a click here, with the stored pair left exactly as it was, and the process's own
// `unhandledRejection` event (what a page reports as an uncaught error) is read, not a spy on the
// code under test.
//
// Real: `EnableItem` (the floating button's switch), the provider editor's assignment switches and
// `ConfigBackupPage` with both of its "Backup now" buttons (the toolbar over a list, and the empty
// state), the config atoms, the settings service and the extension's in-memory browser storage.
// Only the toast manager and the logger are replaced, to read what the page shows and logs.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { isAPIProviderConfig } from "@/types/config/provider"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedBackup,
  seedPrimary,
  snapshot,
  validConfig,
  watchUnhandledRejections,
} from "@/utils/config/__tests__/preservation-test-kit"
import { queryClient } from "@/utils/tanstack-query"
import {
  CustomProviderEditor,
  ProviderEditor,
} from "../api-providers/providers-config/provider-editor"
import { EnableItem } from "../floating-button/enable-item"
import { ConfigBackupPage } from "../preference/config/config-backup"

const toastAdd = vi.hoisted(() => vi.fn<(options: Record<string, unknown>) => unknown>())
const warn = vi.hoisted(() => vi.fn<(...args: unknown[]) => void>())

vi.mock("@/components/ui/base-ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/base-ui/toast")>()),
  toastManager: { add: toastAdd },
}))

vi.mock("@/utils/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/logger")>()
  return { ...actual, logger: { ...actual.logger, warn } }
})

const BACKUP_NOW = "options.preference.config.backup.backupNow"
const NOT_SAVED = "A change to the settings was not saved"
const SUSPECT: RawPrimary = { value: corruptConfig("unusable"), meta: CURRENT_META }

let unhandled: ReturnType<typeof watchUnhandledRejections>

beforeEach(() => {
  resetStorage()
  toastAdd.mockReset()
  warn.mockReset()
  // The page's query cache outlives a test; stale rows would be replaced mid-click.
  queryClient.clear()
  unhandled = watchUnhandledRejections()
})

afterEach(() => {
  cleanup()
  unhandled.stop()
})

function renderSwitch() {
  render(
    <Provider store={createStore()}>
      <EnableItem />
    </Provider>,
  )
  return screen.getByRole("switch")
}

function renderBackupPage() {
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={createStore()}>
        <MemoryRouter>
          <ConfigBackupPage />
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  )
}

async function untilNotSaved() {
  await waitFor(() => expect(warn.mock.calls.map(([message]) => message)).toContain(NOT_SAVED))
}

async function untilToasted() {
  await waitFor(() => expect(toastAdd).toHaveBeenCalled())
}

describe("the floating button's switch over a stored config that cannot be used", () => {
  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
  })

  it("is refused without an uncaught error on the page", async () => {
    const toggle = renderSwitch()

    fireEvent.click(toggle)
    await untilNotSaved()
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
  })

  it("still logs the refusal, stores nothing and shows the switch as it was", async () => {
    const toggle = renderSwitch()
    const shown = toggle.getAttribute("aria-checked")

    fireEvent.click(toggle)
    await untilNotSaved()
    await unhandled.flush()

    expect(warn.mock.calls.find(([message]) => message === NOT_SAVED)?.[1]).toMatchObject({
      name: "ConfigRecoveryRequiredError",
    })
    expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe(shown))
  })
})

describe("control: the floating button's switch over a stored config that can be used", () => {
  it("stores the change without an uncaught error on the page", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const toggle = renderSwitch()
    const wasEnabled = toggle.getAttribute("aria-checked") === "true"

    fireEvent.click(toggle)
    await waitFor(async () =>
      expect(((await readRawPrimary()).value as any).floatingButton.enabled).toBe(!wasEnabled),
    )
    await unhandled.flush()

    expect(unhandled.reasons).toEqual([])
    expect(warn.mock.calls.map(([message]) => message)).not.toContain(NOT_SAVED)
  })
})

describe("control: Backup now over a stored config that cannot be used", () => {
  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
  })

  it("in the toolbar over a list is refused with a notice and no uncaught error", async () => {
    await seedBackup(validConfig(), 1_000)
    renderBackupPage()
    await waitFor(() => screen.getByText(BACKUP_NOW))
    const before = await snapshot()

    fireEvent.click(screen.getByText(BACKUP_NOW))
    await untilToasted()
    await unhandled.flush()

    expect(toastAdd.mock.calls.map(([options]) => options.type)).toEqual(["error"])
    expect(await snapshot()).toEqual(before)
    expect(unhandled.reasons).toEqual([])
  })

  it("in the empty state is refused with a notice and no uncaught error", async () => {
    renderBackupPage()
    await waitFor(() => screen.getByText(BACKUP_NOW))
    const before = await snapshot()

    fireEvent.click(screen.getByText(BACKUP_NOW))
    await untilToasted()
    await unhandled.flush()

    expect(toastAdd.mock.calls.map(([options]) => options.type)).toEqual(["error"])
    expect(await snapshot()).toEqual(before)
    expect(unhandled.reasons).toEqual([])
  })
})

// The editor was open for this provider when the stored config stopped being usable.
const SHOWN_PROVIDER = validConfig().providersConfig.find(isAPIProviderConfig)!

describe.each([
  { name: "a feature", row: <ProviderEditor.FeatureAssignment featureKey="pageTranslation" /> },
  { name: "language detection", row: <ProviderEditor.LanguageDetectionAssignment /> },
  { name: "a custom action", row: <ProviderEditor.CustomActionAssignments /> },
])(
  "the provider editor's switch that assigns $name over a stored config that cannot be used",
  ({ row }) => {
    beforeEach(async () => {
      await seedPrimary(SUSPECT.value, SUSPECT.meta)
    })

    it("is refused and logged without an uncaught error on the page, and stores nothing", async () => {
      render(
        <ThemeProvider>
          <Provider store={createStore()}>
            <CustomProviderEditor.Provider
              providerConfig={SHOWN_PROVIDER}
              form={{} as never}
              duplicate={async () => {}}
              delete={async () => {}}
            >
              {row}
            </CustomProviderEditor.Provider>
          </Provider>
        </ThemeProvider>,
      )

      fireEvent.click(screen.getAllByRole("switch")[0]!)
      await untilNotSaved()
      await unhandled.flush()

      expect(warn.mock.calls.find(([message]) => message === NOT_SAVED)?.[1]).toMatchObject({
        name: "ConfigRecoveryRequiredError",
      })
      expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
      expect(unhandled.reasons).toEqual([])
    })
  },
)
