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
import {
  corruptConfig,
  CURRENT_META,
  MAX_PRESERVED,
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
import { queryClient } from "@/utils/tanstack-query"
import { RecoveryExport } from "../recovery-export"

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
const CANCEL = "recoveryExport.warning.cancel"

const SECRET = "sk-synthetic-sentinel-0000"

function suspectWithSecret(): RawPrimary {
  const value: any = corruptConfig()
  value.providersConfig.find((provider: any) => "apiKey" in provider).apiKey = SECRET
  return { value, meta: CURRENT_META }
}

function renderExport() {
  render(
    <QueryClientProvider client={queryClient}>
      <RecoveryExport />
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

    expect(screen.queryByTestId("recovery-export")).not.toBeInTheDocument()
  })

  it("is nothing when nothing is stored", async () => {
    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(screen.queryByTestId("recovery-export")).not.toBeInTheDocument()
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

describe("a screen that is already showing", () => {
  it("offers recovery when the stored config becomes unusable and a copy is kept, without a reload", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByTestId("recovery-export")).not.toBeInTheDocument()

    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    await seedPreserved(original, "invalid-schema")

    await waitFor(() => expect(screen.getByText(EXPORT_STORED)).toBeVisible())
    expect(screen.getAllByText(EXPORT_COPY)).toHaveLength(1)
  })

  it("lists a copy that is added later, and stops offering the stored config once it is usable again", async () => {
    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    renderExport()
    await waitFor(() => screen.getByText(EXPORT_STORED))
    expect(screen.queryByText(EXPORT_COPY)).not.toBeInTheDocument()

    await seedPreserved(original, "invalid-schema")
    await waitFor(() => expect(screen.getAllByText(EXPORT_COPY)).toHaveLength(1))

    await seedPrimary(validConfig(), CURRENT_META)
    await waitFor(() => expect(screen.queryByText(EXPORT_STORED)).not.toBeInTheDocument())
    expect(screen.getAllByText(EXPORT_COPY)).toHaveLength(1)
  })

  it.each([
    {
      name: "only its value changes",
      change: (fakeBrowser: any) => fakeBrowser.storage.local.set({ config: corruptConfig() }),
    },
    {
      name: "only its meta changes",
      change: (fakeBrowser: any) => fakeBrowser.storage.local.set({ config$: "not-a-meta" }),
    },
  ])("offers recovery when $name", async ({ change }) => {
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    await seedPrimary(validConfig(), CURRENT_META)
    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByTestId("recovery-export")).not.toBeInTheDocument()

    await change(fakeBrowser)

    await waitFor(() => expect(screen.getByText(EXPORT_STORED)).toBeVisible())
  })

  it("shows the outcome of the latest read when an older read answers late", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local) as (
      ...args: any[]
    ) => Promise<Record<string, unknown>>
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstStatusRead = true
    vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation((async (...args: any[]) => {
      const keys = args[0]
      const isStatusRead =
        Array.isArray(keys) && keys.includes("config") && keys.includes("config$")
      const result = await realGet(...args)
      if (isStatusRead && firstStatusRead) {
        firstStatusRead = false
        // The first read answers late, with what was stored when it started.
        await held
      }
      return result
    }) as any)
    renderExport()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const original = suspectWithSecret()
    await seedPrimary(original.value, original.meta)
    await waitFor(() => expect(screen.getByText(EXPORT_STORED)).toBeVisible())
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(screen.getByText(EXPORT_STORED)).toBeVisible()
  })

  it("leaves no listener on the browser's storage once it is gone", async () => {
    const { fakeBrowser } = await import("wxt/testing/fake-browser")
    await seedPrimary(validConfig(), CURRENT_META)
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RecoveryExport />
      </QueryClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(true)

    view.unmount()

    expect(fakeBrowser.storage.onChanged.hasListeners()).toBe(false)
  })
})
