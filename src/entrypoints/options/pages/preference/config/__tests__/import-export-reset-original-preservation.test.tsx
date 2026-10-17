// @vitest-environment jsdom
// Import, export and reset in the options page, and the error screen's reset and export, when the
// stored config cannot be used.
//
// All of them used to work on the DEFAULTS the settings screens show for a stored value that fails
// validation. Exporting current settings would hand the user a file of defaults, and import and
// reset overwrote the original with no copy. Now exporting current settings is BLOCKED while the
// stored config is unusable, an invalid import file is rejected with an error and nothing is
// written, and import, reset and the error screen's reset keep an exact, confirmed copy of an
// unusable stored config (instead of a backup of the defaults) before they replace it.
//
// Real: `ManualConfigSyncConfigItems` (import and export), `ResetConfigItem`, `RecoveryFallback`,
// `useExportConfig`, `getConfigWithoutCredentials`, `migrateConfig`, `initializeConfig`, over the
// extension's in-memory browser storage. Replaced: the toast manager (to read the messages),
// `file-saver` (to see what would be downloaded), and the glossary store and its query hook
// (IndexedDB), which this suite does not exercise. All secrets are synthetic.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecoveryFallback } from "@/components/recovery/recovery-fallback"
import { configSchema } from "@/types/config/config"
import {
  backupEntries,
  corruptConfig,
  CURRENT_META,
  holdFirstCall,
  MAX_PRESERVED,
  PREVIOUS_META,
  preservedCopiesOf,
  previousVersionConfig,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPreserved,
  seedPrimary,
  snapshot,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { decodeLossless } from "@/utils/config/preservation"
import { parseRecoveryExport } from "@/utils/config/recovery-export"
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG } from "@/utils/constants/config"
import { queryClient } from "@/utils/tanstack-query"
import { ConfigManagementSection } from ".."
import { ManualConfigSyncConfigItems } from "../manual-config-sync"
import { ResetConfigItem } from "../reset-config"

const { toastAdd, saveAsMock } = vi.hoisted(() => ({
  toastAdd: vi.fn<(options: Record<string, unknown>) => unknown>(),
  saveAsMock: vi.fn<(blob: Blob, name: string) => void>(),
}))

vi.mock("@/components/ui/base-ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/base-ui/toast")>()),
  toastManager: { add: toastAdd },
}))
vi.mock("file-saver", () => ({ saveAs: saveAsMock }))
vi.mock("@/utils/glossary/sync/local-store", () => ({
  readLocalGlossary: async () => ({ glossaries: [], terms: [] }),
  checkGlossaryCaps: () => null,
  replaceGlossary: async () => ({ ok: true, terms: 0 }),
  restoreUndoSnapshot: async () => true,
}))
vi.mock("@/entrypoints/options/pages/advanced/glossary/use-glossary", () => ({
  useGlossaryInvalidation: () => async () => {},
}))

const EXPORT = "options.preference.config.manualSync.export"
const EXPORT_WITHOUT_KEYS = "options.preference.config.manualSync.exportOptions.excludeAPIKeys"
const EXPORT_WITH_KEYS = "options.preference.config.manualSync.exportOptions.includeAPIKeys"
const RESET_TRIGGER = "options.preference.config.reset.dialog.trigger"
const RESET_CONFIRM = "options.preference.config.reset.dialog.confirm"
const RECOVERY_RESET = "errorRecovery.resetAction"
const RECOVERY_RESET_CONFIRM = "errorRecovery.resetDialog.confirm"
const RECOVERY_EXPORT_WITH_KEYS = "errorRecovery.exportWithApiKeys"

const SENTINEL_KEY = "sk-synthetic-sentinel-0000"

/** A valid config in which the first provider that takes an API key holds a synthetic one. */
function validConfigWithSentinelKey() {
  const config = validConfig() as any
  const provider = config.providersConfig.find((item: any) => "apiKey" in item)
  provider.apiKey = SENTINEL_KEY
  return config
}

const SUSPECT: RawPrimary = { value: corruptConfig("import-over-me"), meta: CURRENT_META }

function renderInProviders(ui: React.ReactElement) {
  const store = createStore()
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{ui}</Provider>
    </QueryClientProvider>,
  )
  return store
}

async function importFile(content: string) {
  const input = document.querySelector<HTMLInputElement>("#import-config-file")!
  const file = new File([content], "config.json", { type: "application/json" })
  fireEvent.change(input, { target: { files: [file] } })
}

function importPayload(config: unknown, schemaVersion: unknown = CONFIG_SCHEMA_VERSION) {
  return JSON.stringify({ config, schemaVersion })
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

async function readBlob(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error("the blob did not read as text"))
    }
    reader.onerror = () => reject(new Error("could not read the blob"))
    reader.readAsText(blob)
  })
}

async function renderSettledSyncItems() {
  const store = renderInProviders(<ManualConfigSyncConfigItems />)
  // `configAtom` reads storage when it mounts; let that settle before anything is clicked.
  await new Promise((resolve) => setTimeout(resolve, 20))
  return store
}

beforeEach(() => {
  resetStorage()
  toastAdd.mockReset()
  saveAsMock.mockReset()
  queryClient.clear()
})

afterEach(() => {
  cleanup()
})

describe("Export current settings while the primary config is not valid", () => {
  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
  })

  it("does not download a file of defaults as the user's settings (without API keys)", async () => {
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(EXPORT_WITHOUT_KEYS))
    fireEvent.click(screen.getByText(EXPORT_WITHOUT_KEYS))
    await untilToasted()

    expect(saveAsMock).not.toHaveBeenCalled()
  })

  it("does not download a file of defaults as the user's settings (with API keys)", async () => {
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(EXPORT_WITH_KEYS))
    fireEvent.click(screen.getByText(EXPORT_WITH_KEYS))
    await untilToasted()

    expect(saveAsMock).not.toHaveBeenCalled()
  })

  it("tells the user the export was blocked, not that it succeeded", async () => {
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(EXPORT_WITHOUT_KEYS))
    fireEvent.click(screen.getByText(EXPORT_WITHOUT_KEYS))
    await untilToasted()

    expect(toastTypes()).not.toContain("success")
    expect(toastTypes()).toContain("error")
  })

  it("leaves the primary alone (a control)", async () => {
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(EXPORT_WITHOUT_KEYS))
    fireEvent.click(screen.getByText(EXPORT_WITHOUT_KEYS))
    await untilToasted()

    expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
  })

  it("is blocked on the error screen too (its export reads the same defaults view)", async () => {
    renderInProviders(<RecoveryFallback error={new Error("boom")} onRecovered={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 20))

    fireEvent.click(screen.getByText(RECOVERY_EXPORT_WITH_KEYS))
    await untilToasted()

    expect(saveAsMock).not.toHaveBeenCalled()
  })
})

describe("Export current settings after a startup that could not upgrade the config", () => {
  // The stored config keeps its older label when startup cannot upgrade it. The settings screen
  // shows the defaults for it; the export must not hand them over as the user's settings.
  beforeEach(async () => {
    const stored: any = previousVersionConfig()
    stored.contextMenu = { enabled: "yes" }
    await seedPrimary(stored, PREVIOUS_META)
    await startBackground()
  })

  it.each([
    { name: "with API keys", label: EXPORT_WITH_KEYS },
    { name: "without API keys", label: EXPORT_WITHOUT_KEYS },
  ])("downloads nothing and shows an error ($name)", async ({ label }) => {
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(label))
    fireEvent.click(screen.getByText(label))
    await untilToasted()

    expect(saveAsMock).not.toHaveBeenCalled()
    expect(toastTypes()).toContain("error")
    expect(toastTypes()).not.toContain("success")
  })

  it("is blocked on the error screen too", async () => {
    renderInProviders(<RecoveryFallback error={new Error("boom")} onRecovered={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 20))

    fireEvent.click(screen.getByText(RECOVERY_EXPORT_WITH_KEYS))
    await untilToasted()

    expect(saveAsMock).not.toHaveBeenCalled()
  })
})

describe("the recovery notice on the settings page and on the error screen", () => {
  const RECOVERY_NOTICE = "recovery-notice"

  async function renderConfigSection() {
    const store = renderInProviders(
      <MemoryRouter>
        <ConfigManagementSection />
      </MemoryRouter>,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    return store
  }

  const EXPORT_COPY = "recoveryExport.exportCopy"
  const EXPORT_STORED = "recoveryExport.exportStored"
  const WARNING_CONFIRM = "recoveryExport.warning.confirm"

  async function startupKeepsOriginal() {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await startBackground()
  }

  it("is on the settings page when the stored config cannot be used, and saves it exactly", async () => {
    await startupKeepsOriginal()
    await renderConfigSection()

    await waitFor(() => screen.getByText(EXPORT_COPY))
    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_CONFIRM))
    fireEvent.click(screen.getByText(WARNING_CONFIRM))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalledOnce())

    const file = parseRecoveryExport(await readBlob(saveAsMock.mock.calls[0]![0]))
    expect(decodeLossless(file.encodedValue)).toEqual(SUSPECT.value)
  })

  it("is on the error screen, where the ordinary export is blocked", async () => {
    await startupKeepsOriginal()
    renderInProviders(<RecoveryFallback error={new Error("boom")} onRecovered={() => {}} />)

    await waitFor(() => screen.getByTestId(RECOVERY_NOTICE))
    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_CONFIRM))
    fireEvent.click(screen.getByText(WARNING_CONFIRM))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalledOnce())

    const file = parseRecoveryExport(await readBlob(saveAsMock.mock.calls[0]![0]))
    expect(decodeLossless(file.encodedValue)).toEqual(SUSPECT.value)
  })

  it("offers the stored config as found on both screens when no copy could be kept", async () => {
    // Startup has not run, so there is no kept copy, as when the store of copies is full.
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await renderConfigSection()
    expect(await screen.findByText(EXPORT_STORED)).toBeVisible()
    cleanup()

    renderInProviders(<RecoveryFallback error={new Error("boom")} onRecovered={() => {}} />)

    expect(await screen.findByText(EXPORT_STORED)).toBeVisible()
  })

  it("is not shown for a usable config with nothing kept (a control)", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await renderConfigSection()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(screen.queryByTestId(RECOVERY_NOTICE)).not.toBeInTheDocument()
  })
})

describe("controls: Export current settings of a valid config (a control)", () => {
  it("downloads the settings without credentials, in the documented file shape", async () => {
    const config = validConfigWithSentinelKey()
    await seedPrimary(config, CURRENT_META)
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(EXPORT_WITHOUT_KEYS))
    fireEvent.click(screen.getByText(EXPORT_WITHOUT_KEYS))
    await untilToasted()

    expect(saveAsMock).toHaveBeenCalledTimes(1)
    const file = JSON.parse(await readBlob(saveAsMock.mock.calls[0]![0]))
    expect(file.schemaVersion).toBe(CONFIG_SCHEMA_VERSION)
    expect(file.config.language).toEqual(config.language)
    expect(JSON.stringify(file.config)).not.toContain(SENTINEL_KEY)
  })

  it("downloads the credentials only when asked to", async () => {
    await seedPrimary(validConfigWithSentinelKey(), CURRENT_META)
    await renderSettledSyncItems()

    fireEvent.click(screen.getByText(EXPORT))
    await waitFor(() => screen.getByText(EXPORT_WITH_KEYS))
    fireEvent.click(screen.getByText(EXPORT_WITH_KEYS))
    await untilToasted()

    const file = JSON.parse(await readBlob(saveAsMock.mock.calls[0]![0]))
    expect(JSON.stringify(file.config)).toContain(SENTINEL_KEY)
  })
})

describe("Import of a file that is not a valid config", () => {
  const REJECTED: Array<{ name: string; content: () => string }> = [
    { name: "text that is not JSON", content: () => "this is not json" },
    { name: "a file without a config", content: () => JSON.stringify({ schemaVersion: 111 }) },
    {
      name: "a file without a schema version",
      content: () => JSON.stringify({ config: validConfig() }),
    },
    {
      name: "a config of the current version that fails the schema",
      content: () => importPayload(corruptConfig("imported-broken")),
    },
    { name: "an empty config", content: () => importPayload({}) },
    {
      name: "a config from a newer version",
      content: () => importPayload(validConfig(), CONFIG_SCHEMA_VERSION + 3),
    },
  ]

  describe.each([
    { primary: "a valid primary", seed: () => seedPrimary(validConfig(), CURRENT_META) },
    {
      primary: "a primary that is not valid",
      seed: () => seedPrimary(SUSPECT.value, SUSPECT.meta),
    },
  ])("over $primary", ({ seed }) => {
    it.each(REJECTED)(
      "rejects $name with an error and writes nothing (a control)",
      async (file) => {
        await seed()
        const before = await snapshot()
        await renderSettledSyncItems()

        await importFile(file.content())
        await untilToasted()

        // The page and the shared mutation cache each show one error toast, so there are two.
        expect(new Set(toastTypes())).toEqual(new Set(["error"]))
        expect(await snapshot()).toEqual(before)
      },
    )
  })
})

describe("Import of a valid file", () => {
  it("stores it over a valid primary and backs up what was there (a control)", async () => {
    const current = validConfig()
    ;(current as any).contextMenu.enabled = false
    await seedPrimary(current, CURRENT_META)
    await renderSettledSyncItems()

    await importFile(importPayload(validConfig()))
    await untilToasted()

    expect(((await readRawPrimary()).value as any).contextMenu.enabled).toBe(true)
    const backups = backupEntries(await snapshot())
    expect(backups).toHaveLength(1)
    expect((backups[0]!.backup.config as any).contextMenu.enabled).toBe(false)
    expect(toastTypes()).toEqual(["success"])
  })

  it("keeps an exact copy of a stored config that cannot be used, then stores the file's config", async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await renderSettledSyncItems()

    await importFile(importPayload(validConfig()))
    await untilToasted()

    const all = await snapshot()
    const copies = preservedCopiesOf(all, SUSPECT)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("invalid-schema")
    expect(backupEntries(all)).toEqual([])
    expect((await readRawPrimary()).value).toEqual(configSchema.parse(validConfig()))
    expect(toastTypes()).toEqual(["success"])
  })

  it("does not put the defaults into the backup list as if they were the user's config", async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    await renderSettledSyncItems()

    await importFile(importPayload(validConfig()))
    await untilToasted()

    const defaultsAsBackup = backupEntries(await snapshot()).filter(
      ({ backup }) => JSON.stringify(backup.config) === JSON.stringify(DEFAULT_CONFIG),
    )
    expect(defaultsAsBackup).toEqual([])
  })

  it("stores the file's config, not a merge of it with the current one (a control)", async () => {
    const current = validConfig()
    ;(current as any).language.targetCode = "fra"
    await seedPrimary(current, CURRENT_META)
    await renderSettledSyncItems()
    const imported = validConfig()
    ;(imported as any).language.targetCode = "kor"

    await importFile(importPayload(imported))
    await untilToasted()

    expect(configSchema.parse((await readRawPrimary()).value)).toEqual(configSchema.parse(imported))
  })
})

describe("Reset to defaults", () => {
  // A successful reset shows no toast: the screen is the confirmation.
  async function untilReset() {
    await waitFor(async () =>
      expect(configSchema.safeParse((await readRawPrimary()).value).success).toBe(true),
    )
  }

  async function confirmReset() {
    fireEvent.click(screen.getByText(RESET_TRIGGER))
    await waitFor(() => screen.getByText(RESET_CONFIRM))
    fireEvent.click(screen.getByText(RESET_CONFIRM))
  }

  it("keeps an exact copy of a stored config that cannot be used, then stores the defaults", async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    renderInProviders(<ResetConfigItem />)

    await confirmReset()
    await untilReset()

    const all = await snapshot()
    const copies = preservedCopiesOf(all, SUSPECT)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.entry.reason).toBe("invalid-schema")
    expect(backupEntries(all)).toEqual([])
    const stored = (await readRawPrimary()).value
    expect(configSchema.safeParse(stored).success).toBe(true)
    expect((stored as any).language.sourceCode).toBe(DEFAULT_CONFIG.language.sourceCode)
  })

  it("keeps a single copy when a startup that ran while it waited kept the original first", async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    renderInProviders(<ResetConfigItem />)
    const resetRead = holdFirstCall("get", (keys) => keys.includes("config"))

    await confirmReset()
    await resetRead.reached
    await startBackground()
    resetRead.release()
    await untilReset()

    expect(preservedCopiesOf(await snapshot(), SUSPECT)).toHaveLength(1)
  })

  it("says in fixed words that there is no room for a copy, and quotes nothing, when it cannot be kept", async () => {
    for (let n = 0; n < MAX_PRESERVED; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    renderInProviders(<ResetConfigItem />)
    const before = await snapshot()

    await confirmReset()
    await untilToasted()

    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "errorRecovery.resetFailed",
      description: "recoveryExport.failure.noRoom",
    })
    expect(await snapshot()).toEqual(before)
  })

  it("replaces a valid config with the defaults (a control)", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    renderInProviders(<ResetConfigItem />)

    fireEvent.click(screen.getByText(RESET_TRIGGER))
    await waitFor(() => screen.getByText(RESET_CONFIRM))
    fireEvent.click(screen.getByText(RESET_CONFIRM))
    await waitFor(async () =>
      expect(((await readRawPrimary()).value as any).language.sourceCode).toBe(
        DEFAULT_CONFIG.language.sourceCode,
      ),
    )

    expect(configSchema.safeParse((await readRawPrimary()).value).success).toBe(true)
  })
})

describe("the error screen's reset", () => {
  it("says in fixed words that there is no room for a copy, and quotes nothing, when it cannot be kept", async () => {
    for (let n = 0; n < MAX_PRESERVED; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    renderInProviders(
      <RecoveryFallback error={new Error("boom")} onRecovered={vi.fn<() => void>()} />,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const before = await snapshot()

    fireEvent.click(screen.getByText(RECOVERY_RESET))
    await waitFor(() => screen.getByText(RECOVERY_RESET_CONFIRM))
    fireEvent.click(screen.getByText(RECOVERY_RESET_CONFIRM))
    await untilToasted()

    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "errorRecovery.resetFailed",
      description: "recoveryExport.failure.noRoom",
    })
    expect(await snapshot()).toEqual(before)
  })

  it("keeps an exact copy of a stored config that cannot be used, then stores fresh defaults", async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
    const onRecovered = vi.fn<() => void>()
    renderInProviders(<RecoveryFallback error={new Error("boom")} onRecovered={onRecovered} />)
    await new Promise((resolve) => setTimeout(resolve, 20))

    fireEvent.click(screen.getByText(RECOVERY_RESET))
    await waitFor(() => screen.getByText(RECOVERY_RESET_CONFIRM))
    fireEvent.click(screen.getByText(RECOVERY_RESET_CONFIRM))
    await untilToasted()

    expect(preservedCopiesOf(await snapshot(), SUSPECT)).toHaveLength(1)
    expect(configSchema.safeParse((await readRawPrimary()).value).success).toBe(true)
    expect(toastTypes()).toEqual(["success"])
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })
})
