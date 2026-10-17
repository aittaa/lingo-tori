// @vitest-environment jsdom
// The options page's backup list - "Backup now" and "Restore" - when the stored config cannot be
// used.
//
// The page shows the DEFAULTS for a stored value that fails validation. "Backup now" and the
// "back up the current config first" step of Restore used to store that view as if it were the
// user's config, and Restore then overwrote the stored value, so the original was gone and the list
// held defaults. Now an unusable stored config is preserved exactly before anything replaces it, the
// defaults are never stored as a backup, "Backup now" refuses, and a restore that cannot be done
// writes nothing and shows an error.
//
// Real: `ConfigBackupPage` with its list, `BackupConfigItem` and its Restore flow, `addBackup`,
// `migrateConfig`, `initializeConfig`, over the extension's in-memory browser storage. Only the toast
// manager is replaced, to read the messages the page shows.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configSchema } from "@/types/config/config"
import {
  backupEntries,
  corruptConfig,
  CURRENT_META,
  failWrites,
  holdFirstCall,
  originalIsSafe,
  PRESERVED_PREFIX,
  readPreserved,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedBackup,
  seedPreserved,
  seedPrimary,
  snapshot,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { MAX_BACKUPS_COUNT } from "@/utils/constants/backup"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { queryClient } from "@/utils/tanstack-query"
import { ConfigBackupPage } from "../config-backup"

const toastAdd = vi.hoisted(() => vi.fn<(options: Record<string, unknown>) => unknown>())

vi.mock("@/components/ui/base-ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/base-ui/toast")>()),
  toastManager: { add: toastAdd },
}))

const RESTORE = "options.preference.config.backup.item.restore"
const RESTORE_CONFIRM = "options.preference.config.backup.restore.confirm"
const BACKUP_NOW = "options.preference.config.backup.backupNow"

function renderBackupPage() {
  const store = createStore()
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <MemoryRouter>
          <ConfigBackupPage />
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  )
  return store
}

async function restoreNewestBackup() {
  await waitFor(() => expect(screen.getAllByText(RESTORE).length).toBeGreaterThan(0))
  fireEvent.click(screen.getAllByText(RESTORE)[0]!)
  await waitFor(() => screen.getByText(RESTORE_CONFIRM))
  fireEvent.click(screen.getByText(RESTORE_CONFIRM))
}

async function untilToasted(count = 1) {
  await waitFor(() => expect(toastAdd.mock.calls.length).toBeGreaterThanOrEqual(count))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function toastTypes() {
  return toastAdd.mock.calls.map(([options]) => options.type)
}

async function startBackground() {
  vi.resetModules()
  const { initializeConfig } = await import("@/utils/config/init")
  return initializeConfig()
}

const SUSPECT: RawPrimary = { value: corruptConfig("restore-me"), meta: CURRENT_META }

beforeEach(() => {
  resetStorage()
  toastAdd.mockReset()
  // The page's query cache outlives a test; stale rows would be replaced mid-click.
  queryClient.clear()
})

afterEach(() => {
  cleanup()
})

describe("Restore over a primary config that is not valid", () => {
  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await seedBackup(validConfig(), 1_000)
  })

  it("keeps the original it overwrites: an exact copy, or the primary itself", async () => {
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    expect(await originalIsSafe(SUSPECT)).toBe(true)
  })

  it("restores the chosen backup as the primary (a control)", async () => {
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    const primary = await readRawPrimary()
    expect(configSchema.safeParse(primary.value).success).toBe(true)
    expect((primary.value as any).contextMenu.enabled).toBe(true)
    expect((primary.meta as any).schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
  })

  it("does not put the defaults into the backup list as if they were the user's config", async () => {
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    const defaultsAsBackup = backupEntries(await snapshot()).filter(
      ({ backup }) => JSON.stringify(backup.config) === JSON.stringify(DEFAULT_CONFIG),
    )
    expect(defaultsAsBackup).toEqual([])
  })

  it("writes nothing and says so when the original cannot be preserved first", async () => {
    renderBackupPage()
    failWrites((keys) => keys.some((key) => key.startsWith(PRESERVED_PREFIX)))

    await restoreNewestBackup()
    await untilToasted()

    expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
    expect(toastTypes()).toContain("error")
    expect(toastTypes()).not.toContain("success")
  })

  it("keeps the original when the restore overlaps a startup on the same primary", async () => {
    renderBackupPage()
    const restoreWrite = holdFirstCall("set", (keys) => keys.includes("config"))

    await restoreNewestBackup()
    await Promise.race([restoreWrite.reached, new Promise((resolve) => setTimeout(resolve, 100))])
    await startBackground().catch(() => undefined)
    restoreWrite.release()
    await untilToasted()

    expect(await originalIsSafe(SUSPECT)).toBe(true)
  })
})

describe("Backup now when the primary config is not valid", () => {
  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await seedBackup(validConfig(), 1_000)
  })

  it("does not store the defaults as the user's config", async () => {
    renderBackupPage()
    await waitFor(() => screen.getByText(BACKUP_NOW))

    fireEvent.click(screen.getByText(BACKUP_NOW))
    await untilToasted()

    const defaultsAsBackup = backupEntries(await snapshot()).filter(
      ({ backup }) => JSON.stringify(backup.config) === JSON.stringify(DEFAULT_CONFIG),
    )
    expect(defaultsAsBackup).toEqual([])
  })

  it("refuses with an error, writes nothing, and leaves the stored config as it is", async () => {
    renderBackupPage()
    await waitFor(() => screen.getByText(BACKUP_NOW))
    const before = await snapshot()

    fireEvent.click(screen.getByText(BACKUP_NOW))
    await untilToasted()

    expect(toastTypes()).toContain("error")
    expect(toastTypes()).not.toContain("success")
    expect(await snapshot()).toEqual(before)
  })

  it("does not rotate a real backup out to make room for a defaults backup", async () => {
    for (let n = 1; n < MAX_BACKUPS_COUNT; n++) await seedBackup(validConfig(), 1_000 + n)
    const idsBefore = backupEntries(await snapshot()).map(({ id }) => id)
    renderBackupPage()
    await waitFor(() => screen.getByText(BACKUP_NOW))

    fireEvent.click(screen.getByText(BACKUP_NOW))
    await untilToasted()

    const idsAfter = backupEntries(await snapshot()).map(({ id }) => id)
    for (const id of idsBefore) expect(idsAfter).toContain(id)
  })
})

describe("a Restore that fails", () => {
  it("writes nothing when the chosen backup is from a newer version, and shows an error (control)", async () => {
    const config = validConfig()
    await seedPrimary(config, CURRENT_META)
    const tooNew = await seedBackup(validConfig(), 1_000)
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    await fakeBrowser.storage.local.set({
      [tooNew]: { schemaVersion: CONFIG_SCHEMA_VERSION + 5, config: validConfig() },
    })
    const before = await snapshot()
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    expect(await snapshot()).toEqual(before)
    expect(toastTypes()).toContain("error")
  })

  it("writes nothing when the chosen backup fails the schema, and shows an error (control)", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await seedBackup(corruptConfig("broken-backup"), 1_000)
    const before = await snapshot()
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    expect(await snapshot()).toEqual(before)
    expect(toastTypes()).toContain("error")
  })

  it("leaves a preserved original in place and does not fall back to defaults (a control)", async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await seedPreserved(SUSPECT)
    await seedBackup(corruptConfig("broken-backup"), 1_000)
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
    expect(await readPreserved()).toHaveLength(1)
    expect(toastTypes()).toContain("error")
  })
})

describe("controls: Restore and Backup now over a valid primary", () => {
  it("backs up the current config first, then restores the chosen backup", async () => {
    const current = validConfig()
    ;(current as any).contextMenu.enabled = false
    await seedPrimary(current, CURRENT_META)
    await seedBackup(validConfig(), 1_000)
    renderBackupPage()

    await restoreNewestBackup()
    await untilToasted()

    const entries = backupEntries(await snapshot())
    expect(entries).toHaveLength(2)
    expect(entries.some(({ backup }) => (backup.config as any).contextMenu.enabled === false)).toBe(
      true,
    )
    expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(true)
    expect(toastTypes()).toEqual(["success"])
  })

  it("adds a backup of a valid primary with Backup now", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await seedBackup({ ...validConfig(), contextMenu: { enabled: false } }, 1_000)
    renderBackupPage()
    await waitFor(() => screen.getByText(BACKUP_NOW))

    fireEvent.click(screen.getByText(BACKUP_NOW))
    await untilToasted()

    expect(backupEntries(await snapshot())).toHaveLength(2)
    expect(await readPreserved()).toEqual([])
  })
})
