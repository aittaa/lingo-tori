// @vitest-environment jsdom
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSaveVocabulary } from "../use-save-to-notebase"
const mocks = vi.hoisted(() => ({
  send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toast: vi.fn<(...args: unknown[]) => unknown>(),
}))
vi.mock("@/utils/learning/messages", () => ({ sendLearningMessage: mocks.send }))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: mocks.toast } }))
const action = { outputSchema: [{ name: "meaning" }] } as SelectionToolbarCustomAction
beforeEach(() => {
  mocks.send.mockReset()
  mocks.toast.mockReset()
})
describe("local vocabulary save action", () => {
  it("saves selection, meaning and context locally without account state", async () => {
    mocks.send.mockResolvedValue({ saved: 1 })
    const { result } = renderHook(() => useSaveVocabulary())
    await act(async () => {
      expect(
        await result.current.save({
          action,
          selection: "猫",
          context: "猫がいる",
          language: "jpn",
          results: [{ meaning: "cat" }],
        }),
      ).toBe("saved")
    })
    expect(mocks.send).toHaveBeenCalledWith("lingotoriSave", [
      {
        term: "猫",
        meaning: "cat",
        context: "猫がいる",
        language: "jpn",
        sourceUrl: window.location.href,
      },
    ])
    expect(result.current.isSaving).toBe(false)
  })
  it("records unknown source language rather than the translation target for short text", async () => {
    mocks.send.mockResolvedValue({ saved: 1 })
    const { result } = renderHook(() => useSaveVocabulary())
    await act(async () => {
      await result.current.save({
        action,
        selection: "猫",
        language: "auto",
        results: [{ meaning: "cat" }],
      })
    })
    expect(mocks.send).toHaveBeenCalledWith("lingotoriSave", [
      expect.objectContaining({ term: "猫", language: "und" }),
    ])
  })
  it("reports failed durable saves and allows retry", async () => {
    mocks.send.mockRejectedValueOnce(new Error("quota")).mockResolvedValueOnce({ saved: 1 })
    const { result } = renderHook(() => useSaveVocabulary())
    const request = { action, selection: "猫", results: [{ meaning: "cat" }] }
    await act(async () => {
      expect(await result.current.save(request)).toBe("failed")
    })
    expect(result.current.isSaving).toBe(false)
    await act(async () => {
      expect(await result.current.save(request)).toBe("saved")
    })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })
})
