import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"

const getLocalConfigMock = vi.fn<(...args: any[]) => any>()
const sendMessageMock = vi.fn<(...args: any[]) => any>()
const serializeProviderRefMock = vi.fn<(...args: any[]) => any>()
const toastAddMock = vi.fn<(...args: any[]) => any>()

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: getLocalConfigMock,
}))

vi.mock("@/utils/message", () => ({
  sendMessage: sendMessageMock,
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => toastAddMock(...args) },
}))

// Only the network-touching resolve is replaced; the error class and the cache
// identity helper must stay real, since the assertions are about them.
vi.mock("@/utils/providers/provider-ref", async () => {
  const actual = await vi.importActual<any>("@/utils/providers/provider-ref")
  return { ...actual, serializeProviderRef: serializeProviderRefMock }
})

describe("subtitles provider setup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLocalConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        providerId: "read-frog-free-ai",
      },
    })
  })

  it("stays silent when no provider is configured at all", async () => {
    getLocalConfigMock.mockResolvedValue({
      ...DEFAULT_CONFIG,
      videoSubtitles: { ...DEFAULT_CONFIG.videoSubtitles, providerId: "does-not-exist" },
    })
    const { translateSubtitles } = await import("../translator")

    const result = await translateSubtitles([{ text: "hello", start: 0, end: 1 }], {
      videoTitle: "V",
    } as never)

    // Not the same condition: nothing was denied, so there is nothing to
    // report to the user. This is the meaning the denial used to collapse into.
    expect(result.map((f) => f.translation)).toEqual([""])
    expect(toastAddMock).not.toHaveBeenCalled()
  })
})
