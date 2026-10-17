// @vitest-environment jsdom
// The recovery export on screen: when this version cannot use the stored settings, the user can
// save them to a file exactly as stored, after a warning that the file holds credentials.
//
// Real: `RecoveryExport`, the recovery export module, the status reader and the preservation store,
// over the extension's in-memory browser storage. Replaced: the toast manager (to read the messages)
// and `file-saver` (to see what would be downloaded). All secrets are synthetic.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { isDeepStrictEqual } from "node:util"
import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configSchema } from "@/types/config/config"
import {
  corruptConfig,
  CURRENT_META,
  MAX_PRESERVED,
  preservedCopiesOf,
  PREVIOUS_META,
  previousVersionConfig,
  readRawPrimary,
  resetStorage,
  seedPreserved,
  seedPrimary,
  snapshot,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { decodeLossless } from "@/utils/config/preservation"
import { parseRecoveryExport } from "@/utils/config/recovery-export"
import { RECOVERY_NOTICE_SECTION_ID } from "@/utils/navigation"
import { queryClient } from "@/utils/tanstack-query"
import { RecoveryNotice } from "../recovery-notice"

const { toastAdd, saveAsMock } = vi.hoisted(() => ({
  toastAdd: vi.fn<(options: Record<string, unknown>) => unknown>(),
  saveAsMock: vi.fn<(blob: Blob, name: string) => void>(),
}))

vi.mock("@/components/ui/base-ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/base-ui/toast")>()),
  toastManager: { add: toastAdd },
}))
vi.mock("file-saver", () => ({ saveAs: saveAsMock }))

const EXPORT_COPY = "recoveryExport.exportCopy"
const EXPORT_STORED = "recoveryExport.exportStored"
const WARNING_TITLE = "recoveryExport.warning.title"
const CONFIRM = "recoveryExport.warning.confirm"
const CANCEL = "recoveryExport.cancel"

const SECRET = "sk-synthetic-sentinel-0000"

function suspectWithSecret(): RawPrimary {
  const value: any = corruptConfig()
  value.providersConfig.find((provider: any) => "apiKey" in provider).apiKey = SECRET
  return { value, meta: CURRENT_META }
}

function renderExport() {
  render(
    <QueryClientProvider client={queryClient}>
      <RecoveryNotice />
    </QueryClientProvider>,
  )
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

beforeEach(() => {
  resetStorage()
  toastAdd.mockReset()
  saveAsMock.mockReset()
  queryClient.clear()
})

afterEach(() => {
  cleanup()
})

describe("what is offered", () => {
  it("is nothing when the config is usable and no copy is kept", async () => {
    await seedPrimary(validConfig(), CURRENT_META)

    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(screen.queryByTestId("recovery-notice")).not.toBeInTheDocument()
  })

  it("is nothing when nothing is stored", async () => {
    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(screen.queryByTestId("recovery-notice")).not.toBeInTheDocument()
  })

  it("lists each kept copy with the reason it was kept, and offers the stored config as found", async () => {
    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    await seedPreserved(original, "invalid-schema")
    await seedPreserved({ value: corruptConfig("two"), meta: CURRENT_META }, "newer-version")

    renderExport()

    await waitFor(() => expect(screen.getAllByText(EXPORT_COPY)).toHaveLength(2))
    expect(screen.getByText("recoveryExport.reason.invalid-schema", { exact: false })).toBeVisible()
    expect(screen.getByText("recoveryExport.reason.newer-version", { exact: false })).toBeVisible()
    expect(screen.getByText(EXPORT_STORED)).toBeVisible()
  })

  it("offers the stored config as found when the store of kept copies is full and holds no copy of it", async () => {
    for (let n = 0; n < MAX_PRESERVED; n++) {
      await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
    }
    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)

    renderExport()

    await waitFor(() => expect(screen.getByText(EXPORT_STORED)).toBeVisible())
  })

  it("offers the stored config as found while it is still labelled with an older version", async () => {
    await seedPrimary(previousVersionConfig(), PREVIOUS_META)

    renderExport()

    await waitFor(() => expect(screen.getByText(EXPORT_STORED)).toBeVisible())
  })

  it("never puts a stored value on the screen", async () => {
    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    await seedPreserved(original, "invalid-schema")

    renderExport()
    await waitFor(() => expect(screen.getAllByText(EXPORT_COPY)).toHaveLength(1))

    expect(document.body.innerHTML).not.toContain(SECRET)
  })
})

describe("the credential warning", () => {
  async function renderWithKeptCopy() {
    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    await seedPreserved(original, "invalid-schema")
    renderExport()
    await waitFor(() => expect(screen.getAllByText(EXPORT_COPY)).toHaveLength(1))
    return original
  }

  it("comes first: nothing is downloaded until it is confirmed", async () => {
    await renderWithKeptCopy()

    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_TITLE))

    expect(saveAsMock).not.toHaveBeenCalled()
  })

  it("downloads nothing when it is cancelled", async () => {
    await renderWithKeptCopy()

    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_TITLE))
    fireEvent.click(screen.getByText(CANCEL))
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(saveAsMock).not.toHaveBeenCalled()
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("downloads the kept copy exactly once it is confirmed, and says it was saved", async () => {
    const original = await renderWithKeptCopy()

    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_TITLE))
    fireEvent.click(screen.getByText(CONFIRM))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalledOnce())

    const [blob, name] = saveAsMock.mock.calls[0]!
    const file = parseRecoveryExport(await readBlob(blob))
    expect(file.source).toBe("kept-copy")
    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), original.value)).toBe(true)
    expect(isDeepStrictEqual(decodeLossless(file.encodedMeta!), original.meta)).toBe(true)
    expect(name).toMatch(/unreadable-settings/)
    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success" })),
    )
  })

  it("downloads the stored config as found, exactly, when that is chosen", async () => {
    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    renderExport()
    await waitFor(() => screen.getByText(EXPORT_STORED))

    fireEvent.click(screen.getByText(EXPORT_STORED))
    await waitFor(() => screen.getByText(WARNING_TITLE))
    fireEvent.click(screen.getByText(CONFIRM))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalledOnce())

    const file = parseRecoveryExport(await readBlob(saveAsMock.mock.calls[0]![0]))
    const stored = await readRawPrimary()
    expect(file.source).toBe("stored-as-found")
    expect(isDeepStrictEqual(decodeLossless(file.encodedValue), stored.value)).toBe(true)
  })

  it("shows an error, and downloads nothing, when the kept copy is gone by the time it is confirmed", async () => {
    await renderWithKeptCopy()
    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_TITLE))
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    const keys = Object.keys(await snapshot()).filter((key) => key.startsWith("configOriginal_"))
    await fakeBrowser.storage.local.remove(keys)

    fireEvent.click(screen.getByText(CONFIRM))
    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
    )

    expect(saveAsMock).not.toHaveBeenCalled()
  })

  it("changes nothing in storage", async () => {
    await renderWithKeptCopy()
    const before = await snapshot()

    fireEvent.click(screen.getByText(EXPORT_COPY))
    await waitFor(() => screen.getByText(WARNING_TITLE))
    fireEvent.click(screen.getByText(CONFIRM))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalledOnce())

    expect(await snapshot()).toEqual(before)
  })
})

describe("the recovery actions", () => {
  const TRY_RESTORE = "recoveryExport.tryRestore"
  const DELETE = "recoveryExport.delete"
  const DEFAULTS = "recoveryExport.startFromDefaults"
  const RESTORE_CONFIRM = "recoveryExport.restoreDialog.confirm"
  const DELETE_CONFIRM = "recoveryExport.deleteDialog.confirm"
  const DEFAULTS_CONFIRM = "recoveryExport.defaultsDialog.confirm"

  function toastTypes() {
    return toastAdd.mock.calls.map(([options]) => options.type)
  }

  async function untilToasted() {
    await waitFor(() => expect(toastAdd).toHaveBeenCalled())
  }

  it("has the id the settings page route scrolls to", async () => {
    await seedPrimary(corruptConfig(), CURRENT_META)

    renderExport()
    const notice = await screen.findByTestId("recovery-notice")

    expect(notice.id).toBe(RECOVERY_NOTICE_SECTION_ID)
  })

  it("lists only the kept copies, with no way to start from the defaults, when the stored config is usable", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    await seedPreserved({ value: corruptConfig("kept"), meta: CURRENT_META })

    renderExport()

    expect(await screen.findByText("recoveryExport.copiesTitle")).toBeVisible()
    expect(screen.getByText(TRY_RESTORE)).toBeVisible()
    expect(screen.getByText(DELETE)).toBeVisible()
    expect(screen.queryByText(DEFAULTS)).not.toBeInTheDocument()
    expect(screen.queryByText(EXPORT_STORED)).not.toBeInTheDocument()
  })

  it("shows a kept copy that appears while the page is open", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByTestId("recovery-notice")).not.toBeInTheDocument()

    await seedPreserved({ value: corruptConfig("kept"), meta: CURRENT_META })

    expect(await screen.findByText(EXPORT_COPY)).toBeVisible()
  })

  describe("Try restore", () => {
    async function withRestorableCopy() {
      await seedPrimary(corruptConfig("stored"), CURRENT_META)
      await seedPreserved({ value: previousVersionConfig(), meta: PREVIOUS_META })
      renderExport()
      await screen.findByText(TRY_RESTORE)
    }

    it("asks first, and changes nothing when it is cancelled", async () => {
      await withRestorableCopy()
      const before = await snapshot()

      fireEvent.click(screen.getByText(TRY_RESTORE))
      await waitFor(() => screen.getByText(RESTORE_CONFIRM))
      fireEvent.click(screen.getByText(CANCEL))
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(await snapshot()).toEqual(before)
      expect(toastAdd).not.toHaveBeenCalled()
    })

    it("restores the kept copy once it is confirmed, says so, and stops offering the defaults", async () => {
      await withRestorableCopy()

      fireEvent.click(screen.getByText(TRY_RESTORE))
      await waitFor(() => screen.getByText(RESTORE_CONFIRM))
      fireEvent.click(screen.getByText(RESTORE_CONFIRM))
      await untilToasted()

      expect(toastTypes()).toEqual(["success"])
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "recoveryExport.restored" }),
      )
      expect(configSchema.safeParse((await readRawPrimary()).value).success).toBe(true)
      await waitFor(() => expect(screen.queryByText(DEFAULTS)).not.toBeInTheDocument())
    })

    it("shows the reason and writes nothing when the copy cannot be restored", async () => {
      await seedPrimary(corruptConfig("stored"), CURRENT_META)
      await seedPreserved({ value: corruptConfig("kept"), meta: CURRENT_META })
      renderExport()
      await screen.findByText(TRY_RESTORE)
      const before = await snapshot()

      fireEvent.click(screen.getByText(TRY_RESTORE))
      await waitFor(() => screen.getByText(RESTORE_CONFIRM))
      fireEvent.click(screen.getByText(RESTORE_CONFIRM))
      await untilToasted()

      expect(toastTypes()).toEqual(["error"])
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "recoveryExport.restoreFailed" }),
      )
      expect(await snapshot()).toEqual(before)
    })
  })

  describe("Delete", () => {
    async function withTwoCopies() {
      await seedPrimary(corruptConfig("stored"), CURRENT_META)
      await seedPreserved({ value: corruptConfig("one"), meta: CURRENT_META })
      await seedPreserved({ value: corruptConfig("two"), meta: CURRENT_META })
      renderExport()
      await waitFor(() => expect(screen.getAllByText(DELETE)).toHaveLength(2))
    }

    it("asks first, and keeps the copy when it is cancelled", async () => {
      await withTwoCopies()

      fireEvent.click(screen.getAllByText(DELETE)[0]!)
      await waitFor(() => screen.getByText(DELETE_CONFIRM))
      fireEvent.click(screen.getByText(CANCEL))
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(screen.getAllByText(DELETE)).toHaveLength(2)
      expect(toastAdd).not.toHaveBeenCalled()
    })

    it("removes exactly that copy once it is confirmed, and the list follows", async () => {
      await withTwoCopies()
      const copiesBefore = Object.keys(await snapshot()).filter((key) =>
        key.startsWith("configOriginal_"),
      )

      fireEvent.click(screen.getAllByText(DELETE)[0]!)
      await waitFor(() => screen.getByText(DELETE_CONFIRM))
      fireEvent.click(screen.getByText(DELETE_CONFIRM))
      await untilToasted()

      expect(toastTypes()).toEqual(["success"])
      await waitFor(() => expect(screen.getAllByText(DELETE)).toHaveLength(1))
      const copiesAfter = Object.keys(await snapshot()).filter((key) =>
        key.startsWith("configOriginal_"),
      )
      expect(copiesAfter).toHaveLength(copiesBefore.length - 1)
      // The stored config is untouched, and still offered as found.
      expect(screen.getByText(EXPORT_STORED)).toBeVisible()
    })
  })

  describe("Start from defaults", () => {
    async function withUnusableStored() {
      await seedPrimary(corruptConfig("stored"), CURRENT_META)
      renderExport()
      await screen.findByText(DEFAULTS)
    }

    it("asks first, and changes nothing when it is cancelled", async () => {
      await withUnusableStored()
      const before = await snapshot()

      fireEvent.click(screen.getByText(DEFAULTS))
      await waitFor(() => screen.getByText(DEFAULTS_CONFIRM))
      fireEvent.click(screen.getByText(CANCEL))
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(await snapshot()).toEqual(before)
    })

    it("replaces the stored config with the defaults once it is confirmed, keeping a copy of it", async () => {
      await withUnusableStored()
      const original = await readRawPrimary()

      fireEvent.click(screen.getByText(DEFAULTS))
      await waitFor(() => screen.getByText(DEFAULTS_CONFIRM))
      fireEvent.click(screen.getByText(DEFAULTS_CONFIRM))
      await untilToasted()

      expect(toastTypes()).toEqual(["success"])
      expect(configSchema.safeParse((await readRawPrimary()).value).success).toBe(true)
      expect(preservedCopiesOf(await snapshot(), original)).toHaveLength(1)
      await waitFor(() => expect(screen.queryByText(DEFAULTS)).not.toBeInTheDocument())
    })

    it("replaces nothing, and says why, when a copy cannot be kept first", async () => {
      for (let n = 0; n < MAX_PRESERVED; n++) {
        await seedPreserved({ value: corruptConfig(`other-${n}`), meta: CURRENT_META })
      }
      await withUnusableStored()
      const before = await snapshot()

      fireEvent.click(screen.getByText(DEFAULTS))
      await waitFor(() => screen.getByText(DEFAULTS_CONFIRM))
      fireEvent.click(screen.getByText(DEFAULTS_CONFIRM))
      await untilToasted()

      expect(toastTypes()).toEqual(["error"])
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "recoveryExport.defaultsFailed" }),
      )
      expect(await snapshot()).toEqual(before)
    })
  })
})
