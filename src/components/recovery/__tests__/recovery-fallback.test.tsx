// @vitest-environment jsdom
// The error screen's guidance while the saved settings cannot be used.
//
// "Export current settings" is refused then (the settings screens run on the defaults, which are
// not the user's settings), so the screen must not recommend it or offer its buttons. It points to
// the recovery notice's exact exports instead, which keep the credentials and warn before saving.
// With usable settings the screen is unchanged.
//
// Real: `RecoveryFallback`, the recovery notice, the health atoms and the status reader, over the
// extension's in-memory browser storage. Replaced: the toast manager.

import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  corruptConfig,
  CURRENT_META,
  PREVIOUS_META,
  previousVersionConfig,
  resetStorage,
  seedPrimary,
  settle,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { queryClient } from "@/utils/tanstack-query"
import { RecoveryFallback } from "../recovery-fallback"

vi.mock("@/components/ui/base-ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/base-ui/toast")>()),
  toastManager: { add: vi.fn<(options: Record<string, unknown>) => unknown>() },
}))

const USABLE_DESCRIPTION = "errorRecovery.description"
const USABLE_BACKUP_TITLE = "errorRecovery.backupTitle"
const EXPORT_WITH_KEYS = "errorRecovery.exportWithApiKeys"
const EXPORT_WITHOUT_KEYS = "errorRecovery.exportWithoutApiKeys"
const UNUSABLE_DESCRIPTION = "errorRecovery.unusableDescription"
const UNUSABLE_BACKUP_TITLE = "errorRecovery.unusableBackupTitle"
const UNUSABLE_BACKUP_HINT = "errorRecovery.unusableBackupHint"
const EXPORT_STORED = "recoveryExport.exportStored"

beforeEach(() => {
  resetStorage()
  queryClient.clear()
})

afterEach(() => {
  cleanup()
})

function renderScreen() {
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={createStore()}>
        <RecoveryFallback error={new Error("boom")} onRecovered={() => {}} />
      </Provider>
    </QueryClientProvider>,
  )
}

function expectOrdinaryGuidance() {
  expect(screen.getByText(USABLE_DESCRIPTION)).toBeVisible()
  expect(screen.getByText(USABLE_BACKUP_TITLE)).toBeVisible()
  expect(screen.getByText(EXPORT_WITH_KEYS)).toBeVisible()
  expect(screen.getByText(EXPORT_WITHOUT_KEYS)).toBeVisible()
  expect(screen.queryByText(UNUSABLE_DESCRIPTION)).not.toBeInTheDocument()
  expect(screen.queryByText(UNUSABLE_BACKUP_HINT)).not.toBeInTheDocument()
}

async function expectGuidanceToTheExactExports() {
  await screen.findByText(UNUSABLE_DESCRIPTION)
  expect(screen.getByText(UNUSABLE_BACKUP_TITLE)).toBeVisible()
  expect(screen.getByText(UNUSABLE_BACKUP_HINT)).toBeVisible()
  // The ordinary recommendation and its buttons are gone: that export is refused for this config.
  expect(screen.queryByText(USABLE_DESCRIPTION)).not.toBeInTheDocument()
  expect(screen.queryByText(USABLE_BACKUP_TITLE)).not.toBeInTheDocument()
  expect(screen.queryByText(EXPORT_WITH_KEYS)).not.toBeInTheDocument()
  expect(screen.queryByText(EXPORT_WITHOUT_KEYS)).not.toBeInTheDocument()
  // What it points to is on the same screen.
  expect(await screen.findByText(EXPORT_STORED)).toBeVisible()
}

describe("the error screen while the saved settings cannot be used", () => {
  it("points to the exact exports and offers no export of the current settings", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    renderScreen()

    expect(await screen.findByText(UNUSABLE_DESCRIPTION)).toBeVisible()
    await expectGuidanceToTheExactExports()
  })

  it("does the same for settings that have not been upgraded", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)

    renderScreen()

    expect(await screen.findByText(UNUSABLE_DESCRIPTION)).toBeVisible()
    await expectGuidanceToTheExactExports()
  })

  it("keeps the other recovery options (refresh, reset)", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    renderScreen()
    await expectGuidanceToTheExactExports()

    expect(screen.getByText("errorRecovery.refreshPage")).toBeVisible()
    expect(screen.getByText("errorRecovery.resetAction")).toBeVisible()
  })
})

describe("the error screen while the saved settings can be used", () => {
  it("keeps today's recommendation and both export buttons (a control)", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    renderScreen()
    await settle()

    expect(screen.getByText(USABLE_DESCRIPTION)).toBeVisible()
    expectOrdinaryGuidance()
  })

  it("does the same when nothing is stored (a control)", async () => {
    renderScreen()
    await settle()

    expect(screen.getByText(USABLE_DESCRIPTION)).toBeVisible()
    expectOrdinaryGuidance()
  })
})

describe("an error screen that is already showing", () => {
  it("switches to the guidance for unusable settings, and back, as the saved settings change", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    renderScreen()
    await settle()
    expectOrdinaryGuidance()

    await seedPrimary(corruptConfig(), CURRENT_META)
    await waitFor(() => expect(screen.getByText(UNUSABLE_DESCRIPTION)).toBeVisible())
    expect(screen.queryByText(EXPORT_WITH_KEYS)).not.toBeInTheDocument()

    await seedPrimary(validConfig(), CURRENT_META)
    await waitFor(() => expect(screen.getByText(USABLE_DESCRIPTION)).toBeVisible())
    expectOrdinaryGuidance()
  })
})
