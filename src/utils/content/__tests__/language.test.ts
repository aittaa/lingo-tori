import { franc } from "franc"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("franc", () => ({
  franc: vi.fn<(...args: any[]) => any>(),
}))

const { getLocalConfigMock, serializeProviderRefMock, toastAddMock } = vi.hoisted(() => ({
  toastAddMock: vi.fn<(...args: any[]) => any>(),
  getLocalConfigMock: vi.fn<(...args: any[]) => any>(),
  serializeProviderRefMock: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => toastAddMock(...args) },
}))

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: getLocalConfigMock,
}))

// Only the network-touching resolve is replaced; the error class stays real,
// since recognizing it is what the assertions are about.
vi.mock("@/utils/providers/provider-ref", async () => {
  const actual = await vi.importActual<any>("@/utils/providers/provider-ref")
  return { ...actual, serializeProviderRef: serializeProviderRefMock }
})

const { detectLanguageWithSource } = await import("../language")

const mockFranc = vi.mocked(franc)

describe("detectLanguageWithSource", () => {
  beforeEach(() => {
    mockFranc.mockReset()
  })

  it("returns franc result when it is a supported language code", async () => {
    mockFranc.mockReturnValue("eng")

    await expect(
      detectLanguageWithSource("This is enough text to detect language."),
    ).resolves.toEqual({
      code: "eng",
      source: "franc",
    })
  })

  it("falls back when franc returns an unsupported language code", async () => {
    mockFranc.mockReturnValue("vmw")

    await expect(
      detectLanguageWithSource("Eyi je oro ni ede Yoruba fun idanwo wiwa ede."),
    ).resolves.toEqual({
      code: "und",
      source: "fallback",
    })
  })

  it("makes no model request when no provider is configured", async () => {
    getLocalConfigMock.mockResolvedValue({
      languageDetection: { mode: "llm", providerId: "unconfigured" },
      providersConfig: [],
    })
    mockFranc.mockReturnValue("eng")
    await expect(
      detectLanguageWithSource("This is enough text to detect language.", { enableLLM: true }),
    ).resolves.toEqual({ code: "eng", source: "franc" })
    expect(serializeProviderRefMock).not.toHaveBeenCalled()
  })
})
