import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SubtitleCopyPhase } from "../atoms"
import { SubtitleClipboardExporter } from "../subtitle-clipboard-exporter"

const toastAdd = vi.hoisted(() => vi.fn<(...args: any[]) => any>())
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: toastAdd } }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function setup() {
  let context = "video-1"
  const writeText = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  const prepare = vi.fn<(...args: any[]) => any>().mockResolvedValue("subtitle text")
  const setStatus = vi.fn<(...args: any[]) => any>()
  const exporter = new SubtitleClipboardExporter(prepare, setStatus, () => context)
  return {
    exporter,
    prepare,
    setStatus,
    writeText,
    navigate: () => {
      context = "video-2"
    },
  }
}

describe("subtitle clipboard export lifecycle (mocked browser API)", () => {
  it("prepares without writing, copies on the next call, and retains text after permission rejection", async () => {
    const { exporter, prepare, setStatus, writeText } = setup()
    await exporter.run()
    expect(writeText).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenLastCalledWith({ phase: SubtitleCopyPhase.Ready, progress: null })
    writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"))
    const deniedCopy = exporter.run()
    expect(writeText).toHaveBeenCalledWith("subtitle text")
    await deniedCopy
    expect(setStatus).toHaveBeenLastCalledWith({
      phase: SubtitleCopyPhase.CopyFailed,
      progress: null,
    })
    await exporter.run()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenLastCalledWith({
      phase: SubtitleCopyPhase.Complete,
      progress: null,
    })
    exporter.dispose()
  })

  it("discards prepared text when the video changes before the navigation listener runs", async () => {
    const { exporter, prepare, writeText, navigate } = setup()
    await exporter.run()
    navigate()
    await exporter.run()
    expect(writeText).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it("disposal prevents late preparation from restoring ready state", async () => {
    const { exporter, prepare, setStatus, writeText } = setup()
    let finish!: (text: string) => void
    prepare.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const pending = exporter.run()
    exporter.dispose()
    finish("old text")
    await pending
    expect(setStatus).toHaveBeenLastCalledWith({ phase: SubtitleCopyPhase.Idle, progress: null })
    expect(writeText).not.toHaveBeenCalled()
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("ignores duplicate copy clicks and completion after disposal", async () => {
    const { exporter, writeText, setStatus } = setup()
    await exporter.run()
    let finish!: () => void
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const pending = exporter.run()
    await exporter.run()
    expect(writeText).toHaveBeenCalledTimes(1)
    exporter.dispose()
    finish()
    await pending
    await vi.runAllTimersAsync()
    expect(setStatus).toHaveBeenLastCalledWith({ phase: SubtitleCopyPhase.Idle, progress: null })
  })

  it("fails closed for empty serialized subtitles", async () => {
    const { exporter, prepare, setStatus, writeText } = setup()
    prepare.mockResolvedValueOnce(" ")
    await exporter.run()
    expect(setStatus).toHaveBeenLastCalledWith({ phase: SubtitleCopyPhase.Idle, progress: null })
    expect(writeText).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalled()
  })
})
