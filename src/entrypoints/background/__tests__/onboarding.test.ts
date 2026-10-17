import type { Config } from "@/types/config/config"
import type { OnboardingStatus } from "@/utils/onboarding/lifecycle"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { browser, storage } from "#imports"
import { editConfig } from "@/utils/config/write-guard"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { ONBOARDING_STORAGE_KEY, readOnboardingState } from "@/utils/onboarding/lifecycle"
import {
  createOnboardingCoordinator,
  handleInstallOnboarding,
  setupOnboardingMessageHandlers,
} from "../onboarding"

const { ensureInitializedConfigMock, onMessageMock } = vi.hoisted(() => ({
  ensureInitializedConfigMock: vi.fn<(...args: any[]) => any>(),
  onMessageMock: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("../config", () => ({ ensureInitializedConfig: ensureInitializedConfigMock }))
vi.mock("@/utils/message", () => ({ onMessage: onMessageMock }))

const onboardingKey = `local:${ONBOARDING_STORAGE_KEY}` as const
const configKey = `local:${CONFIG_STORAGE_KEY}` as const

// Keys whose next writes should fail, with how many.
let failingWrites: Map<string, number>
let writesTo: Map<string, number>

function installWriteSpy() {
  const realSetItem = storage.setItem.bind(storage) as (...args: any[]) => Promise<void>
  vi.spyOn(storage, "setItem").mockImplementation(((key: string, ...rest: any[]) => {
    writesTo.set(key, (writesTo.get(key) ?? 0) + 1)
    const remaining = failingWrites.get(key) ?? 0
    if (remaining > 0) {
      failingWrites.set(key, remaining - 1)
      return Promise.reject(new Error(`write to ${key} failed`))
    }
    return realSetItem(key, ...rest)
  }) as typeof storage.setItem)

  // The config is committed by the settings service in one `storage.local.set` call carrying the
  // value and its meta, so a write of the config is counted (and made to fail) there, under the
  // same `local:config` name.
  const realSet = browser.storage.local.set.bind(browser.storage.local)
  vi.spyOn(browser.storage.local, "set").mockImplementation((items: Record<string, unknown>) => {
    const name = "local:config"
    if (Object.keys(items).includes("config")) {
      writesTo.set(name, (writesTo.get(name) ?? 0) + 1)
      const remaining = failingWrites.get(name) ?? 0
      if (remaining > 0) {
        failingWrites.set(name, remaining - 1)
        return Promise.reject(new Error(`write to ${name} failed`))
      }
    }
    return realSet(items)
  })
}

function failNextWritesTo(key: string, count = 1) {
  failingWrites.set(key, count)
}

function writeCount(key: string) {
  return writesTo.get(key) ?? 0
}

async function seedConfig(edit?: (config: Config) => void) {
  const config = structuredClone(DEFAULT_CONFIG)
  edit?.(config)
  await storage.setItem(configKey, config)
  writesTo.clear()
  return config
}

async function seedStatus(status: OnboardingStatus) {
  await storage.setItem(onboardingKey, { version: 1, status })
  writesTo.clear()
}

async function storedConfig() {
  return (await storage.getItem<Config>(configKey))!
}

describe("background onboarding", () => {
  beforeEach(() => {
    failingWrites = new Map()
    writesTo = new Map()
    ensureInitializedConfigMock.mockReset()
    ensureInitializedConfigMock.mockResolvedValue(null)
    onMessageMock.mockReset()
    installWriteSpy()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fakeBrowser.reset()
  })

  describe("handleInstall", () => {
    it("enrols a first install that found no config and asks for the pending page", async () => {
      const onboarding = createOnboardingCoordinator()

      const started = await onboarding.handleInstall({
        reason: "install",
        initResult: { hadStoredConfig: false },
      })

      expect(started).toBe(true)
      expect(await storage.getItem(onboardingKey)).toEqual({ version: 1, status: "pending" })
    })

    it("does not save a language on install, so nothing is chosen from the browser locale", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedConfig()

      await onboarding.handleInstall({ reason: "install", initResult: { hadStoredConfig: false } })

      expect(writeCount(configKey)).toBe(0)
      expect((await storedConfig()).language.targetCode).toBe(DEFAULT_CONFIG.language.targetCode)
    })

    it.each([
      // An existing config — even one that had to be rebuilt — is an existing user.
      ["install", true],
      ["update", false],
      ["update", true],
      ["chrome_update", false],
    ])("leaves %s with hadStoredConfig=%s alone", async (reason, hadStoredConfig) => {
      const onboarding = createOnboardingCoordinator()

      const started = await onboarding.handleInstall({ reason, initResult: { hadStoredConfig } })

      expect(started).toBe(false)
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await readOnboardingState()).toBe("absent")
    })

    it("falls back to the ordinary open when the record cannot be written", async () => {
      const onboarding = createOnboardingCoordinator()
      failNextWritesTo(onboardingKey)

      const started = await onboarding.handleInstall({
        reason: "install",
        initResult: { hadStoredConfig: false },
      })

      expect(started).toBe(false)
      expect(await readOnboardingState()).toBe("absent")
    })

    it("never enrols over an unreadable record", async () => {
      const onboarding = createOnboardingCoordinator()
      await storage.setItem(onboardingKey, { version: 99, status: "pending" })
      writesTo.clear()

      const started = await onboarding.handleInstall({
        reason: "install",
        initResult: { hadStoredConfig: false },
      })

      expect(started).toBe(false)
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await storage.getItem(onboardingKey)).toEqual({ version: 99, status: "pending" })
    })

    it.each<[OnboardingStatus, boolean]>([
      ["pending", true],
      ["dismissed", false],
      ["completed", false],
    ])("keeps an existing %s record and answers %s", async (status, expected) => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus(status)

      const started = await onboarding.handleInstall({
        reason: "install",
        initResult: { hadStoredConfig: false },
      })

      expect(started).toBe(expected)
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await readOnboardingState()).toBe(status)
    })

    it("is wired to the shared worker-wide coordinator", async () => {
      expect(
        await handleInstallOnboarding({
          reason: "update",
          initResult: { hadStoredConfig: false },
        }),
      ).toBe(false)
    })
  })

  describe("complete", () => {
    it("saves only the target language, from the latest stored config", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig((config) => {
        config.language.sourceCode = "spa"
        config.language.level = "advanced"
        config.uiLanguage = "ko"
      })

      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect(await readOnboardingState()).toBe("completed")
      const saved = await storedConfig()
      expect(saved.language).toEqual({ sourceCode: "spa", targetCode: "kor", level: "advanced" })
      expect(saved.uiLanguage).toBe("ko")
      expect(saved.providersConfig).toEqual(DEFAULT_CONFIG.providersConfig)
      expect(saved.pageTranslation.providerId).toBe(DEFAULT_CONFIG.pageTranslation.providerId)
      expect(saved.translationHub).toEqual(DEFAULT_CONFIG.translationHub)
    })

    it("is applied over an edit made after the options page loaded", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      // Another tab changes an unrelated setting between the page loading and the answer.
      const edited = await storedConfig()
      edited.language.sourceCode = "jpn"
      edited.pageTranslation.mode = "translationOnly"
      await storage.setItem(configKey, edited)

      await onboarding.transition({ event: "complete", targetCode: "kor" })

      const saved = await storedConfig()
      expect(saved.language).toMatchObject({ sourceCode: "jpn", targetCode: "kor" })
      expect(saved.pageTranslation.mode).toBe("translationOnly")
    })

    it("waits for config initialization before touching the config", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()

      await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(ensureInitializedConfigMock).toHaveBeenCalledOnce()
    })

    it("completes a dismissed profile too", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("dismissed")
      await seedConfig()

      const result = await onboarding.transition({ event: "complete", targetCode: "jpn" })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("jpn")
    })

    it("writes nothing for a profile that was never enrolled", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedConfig()

      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: false, reason: "not-eligible" })
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await readOnboardingState()).toBe("absent")
      expect((await storedConfig()).language.targetCode).toBe(DEFAULT_CONFIG.language.targetCode)
    })

    it("writes nothing over an unreadable record", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedConfig()
      await storage.setItem(onboardingKey, "garbage")
      writesTo.clear()

      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: false, reason: "not-eligible" })
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await storage.getItem(onboardingKey)).toBe("garbage")
    })

    it("lets a stale tab finish without overwriting the language a completion already saved", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      writesTo.clear()

      // A second tab still showing the question picks another language afterwards.
      const result = await onboarding.transition({ event: "complete", targetCode: "jpn" })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)
      expect((await storedConfig()).language.targetCode).toBe("kor")
    })

    it("makes the first of two simultaneous completions win", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()

      const [first, second] = await Promise.all([
        onboarding.transition({ event: "complete", targetCode: "kor" }),
        onboarding.transition({ event: "complete", targetCode: "jpn" }),
      ])

      expect(first).toEqual({ ok: true, status: "completed" })
      expect(second).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("kor")
      expect(writeCount(configKey)).toBe(1)
      expect(await readOnboardingState()).toBe("completed")
    })

    it.each([
      ["complete then dismiss", ["complete", "dismiss"]],
      ["dismiss then complete", ["dismiss", "complete"]],
    ] as const)("ends completed when %s arrive together", async (_label, order) => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()

      await Promise.all(
        order.map((event) =>
          onboarding.transition(event === "complete" ? { event, targetCode: "kor" } : { event }),
        ),
      )

      expect(await readOnboardingState()).toBe("completed")
      expect((await storedConfig()).language.targetCode).toBe("kor")
    })

    it("does not let a stale dismissal undo a completion", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      writesTo.clear()

      const result = await onboarding.transition({ event: "dismiss" })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await readOnboardingState()).toBe("completed")
    })
  })

  describe("a completion that fails part way", () => {
    it("reports a failed language save and leaves everything as it was", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(configKey)

      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: false, reason: "target-save-failed" })
      expect(await readOnboardingState()).toBe("pending")
      expect((await storedConfig()).language.targetCode).toBe(DEFAULT_CONFIG.language.targetCode)
      expect(writeCount(onboardingKey)).toBe(0)
    })

    it("recovers from a failed language save on the next try", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(configKey)
      await onboarding.transition({ event: "complete", targetCode: "kor" })

      const retry = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(retry).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("kor")
      expect(await readOnboardingState()).toBe("completed")
    })

    it("reports a failed record write after the language was saved", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)

      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: false, reason: "lifecycle-save-failed" })
      expect((await storedConfig()).language.targetCode).toBe("kor")
      expect(await readOnboardingState()).toBe("pending")
    })

    it("finishes only the missing step on retry", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      expect(writeCount(configKey)).toBe(1)

      const retry = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(retry).toEqual({ ok: true, status: "completed" })
      expect(writeCount(configKey)).toBe(1)
      expect(await readOnboardingState()).toBe("completed")
    })

    it("does not rewrite the language over an edit made between the attempts", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      // Settings changes the target in the meantime.
      const edited = await storedConfig()
      edited.language.targetCode = "fra"
      await storage.setItem(configKey, edited)

      const retry = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(retry).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("fra")
      expect(await readOnboardingState()).toBe("completed")
    })

    it("writes a language the person confirms afresh, even one an unfinished attempt saved", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      // Settings changes the target afterwards (through the settings writer, which keeps the
      // stored value and its meta together).
      await editConfig((current) => ({
        ...current,
        language: { ...current.language, targetCode: "jpn" },
      }))
      writesTo.clear()

      // Not a retry: the person chose Korean again, so it is saved as any confirmation is.
      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("kor")
      expect(writeCount(configKey)).toBe(1)
      expect(await readOnboardingState()).toBe("completed")
    })

    it("saves a different choice made after the record write failed", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)
      await onboarding.transition({ event: "complete", targetCode: "kor" })

      const retry = await onboarding.transition({ event: "complete", targetCode: "jpn" })

      expect(retry).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("jpn")
    })

    it("survives repeated record failures and still finishes later", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey, 2)

      const retry = { event: "complete", targetCode: "kor", retryCompletionOnly: true } as const
      const results = [
        await onboarding.transition({ event: "complete", targetCode: "kor" }),
        await onboarding.transition(retry),
        await onboarding.transition(retry),
      ]

      expect(results.map((result) => result.ok)).toEqual([false, false, true])
      expect(writeCount(configKey)).toBe(1)
      expect(await readOnboardingState()).toBe("completed")
    })

    it("reports a record that cannot be read before saving anything", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      vi.spyOn(storage, "getItem").mockImplementationOnce(() =>
        Promise.reject(new Error("read failed")),
      )

      const result = await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(result).toEqual({ ok: false, reason: "target-save-failed" })
      expect(writeCount(configKey)).toBe(0)
      expect(await readOnboardingState()).toBe("pending")
    })
  })

  describe("retryCompletionOnly", () => {
    it("saves the target exactly once on an ordinary first completion", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()

      await onboarding.transition({ event: "complete", targetCode: "kor" })

      expect(writeCount(configKey)).toBe(1)
      expect(writeCount(onboardingKey)).toBe(1)
    })

    it("completes after a worker restart without rewriting a language changed since", async () => {
      await seedStatus("pending")
      await seedConfig()
      const beforeRestart = createOnboardingCoordinator()
      failNextWritesTo(onboardingKey)
      const failed = await beforeRestart.transition({ event: "complete", targetCode: "kor" })
      expect(failed).toEqual({ ok: false, reason: "lifecycle-save-failed" })
      expect((await storedConfig()).language.targetCode).toBe("kor")

      // A new coordinator stands in for a restarted worker; settings changes the target meanwhile.
      const afterRestart = createOnboardingCoordinator()
      const edited = await storedConfig()
      edited.language.targetCode = "jpn"
      await storage.setItem(configKey, edited)
      writesTo.clear()

      const retry = await afterRestart.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(retry).toEqual({ ok: true, status: "completed" })
      expect(await readOnboardingState()).toBe("completed")
      expect((await storedConfig()).language.targetCode).toBe("jpn")
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(1)
      expect(ensureInitializedConfigMock).toHaveBeenCalledTimes(1)
    })

    it("never writes a language, whichever one it names", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      const edited = await storedConfig()
      edited.language.targetCode = "fra"
      await storage.setItem(configKey, edited)
      writesTo.clear()

      // An ordinary completion naming another language would be saved; the explicit retry is not.
      await onboarding.transition({
        event: "complete",
        targetCode: "jpn",
        retryCompletionOnly: true,
      })

      expect((await storedConfig()).language.targetCode).toBe("fra")
      expect(writeCount(configKey)).toBe(0)
    })

    it("completes a dismissed profile without writing a language", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("dismissed")
      await seedConfig()

      const result = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect(writeCount(configKey)).toBe(0)
      expect((await storedConfig()).language.targetCode).toBe(DEFAULT_CONFIG.language.targetCode)
    })

    it("writes nothing for a completed profile", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("completed")
      await seedConfig()

      const result = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)
    })

    it("writes nothing for a profile that was never enrolled", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedConfig()

      const result = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(result).toEqual({ ok: false, reason: "not-eligible" })
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await readOnboardingState()).toBe("absent")
    })

    it("writes nothing over an unreadable record", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedConfig()
      await storage.setItem(onboardingKey, { version: 99, status: "pending" })
      writesTo.clear()

      const result = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(result).toEqual({ ok: false, reason: "not-eligible" })
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)
    })

    it("reports a failing record write again without touching the language", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey)

      const result = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(result).toEqual({ ok: false, reason: "lifecycle-save-failed" })
      expect(writeCount(configKey)).toBe(0)
      expect(await readOnboardingState()).toBe("pending")
    })

    it("keeps reporting a record failure when the record cannot be read", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      vi.spyOn(storage, "getItem").mockImplementationOnce(() =>
        Promise.reject(new Error("read failed")),
      )

      const result = await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })

      expect(result).toEqual({ ok: false, reason: "lifecycle-save-failed" })
      expect(writeCount(configKey)).toBe(0)
    })

    it("lets an ordinary completion save a freshly chosen language afterwards", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()
      failNextWritesTo(onboardingKey, 2)
      await onboarding.transition({ event: "complete", targetCode: "kor" })
      await onboarding.transition({
        event: "complete",
        targetCode: "kor",
        retryCompletionOnly: true,
      })
      writesTo.clear()

      const result = await onboarding.transition({ event: "complete", targetCode: "jpn" })

      expect(result).toEqual({ ok: true, status: "completed" })
      expect((await storedConfig()).language.targetCode).toBe("jpn")
      expect(writeCount(configKey)).toBe(1)
    })
  })

  describe("dismiss", () => {
    it("records Later without touching the config", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()

      const result = await onboarding.transition({ event: "dismiss" })

      expect(result).toEqual({ ok: true, status: "dismissed" })
      expect(await readOnboardingState()).toBe("dismissed")
      expect(writeCount(configKey)).toBe(0)
      expect(ensureInitializedConfigMock).not.toHaveBeenCalled()
    })

    it("is a no-op for an already dismissed profile", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("dismissed")

      const result = await onboarding.transition({ event: "dismiss" })

      expect(result).toEqual({ ok: true, status: "dismissed" })
      expect(writeCount(onboardingKey)).toBe(0)
    })

    it("writes nothing for a profile that was never enrolled", async () => {
      const onboarding = createOnboardingCoordinator()

      const result = await onboarding.transition({ event: "dismiss" })

      expect(result).toEqual({ ok: false, reason: "not-eligible" })
      expect(writeCount(onboardingKey)).toBe(0)
      expect(await readOnboardingState()).toBe("absent")
    })

    it("reports a failed write and keeps the question pending", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      failNextWritesTo(onboardingKey)

      const result = await onboarding.transition({ event: "dismiss" })

      expect(result).toEqual({ ok: false, reason: "lifecycle-save-failed" })
      expect(await readOnboardingState()).toBe("pending")
    })
  })

  describe("the queue", () => {
    it("keeps serving after a failed task", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      failNextWritesTo(onboardingKey)

      const [failed, dismissed] = await Promise.all([
        onboarding.transition({ event: "dismiss" }),
        onboarding.transition({ event: "dismiss" }),
      ])

      expect(failed).toEqual({ ok: false, reason: "lifecycle-save-failed" })
      expect(dismissed).toEqual({ ok: true, status: "dismissed" })
    })

    it("rejects a malformed message without disturbing the queue", async () => {
      const onboarding = createOnboardingCoordinator()
      await seedStatus("pending")
      await seedConfig()

      await expect(
        onboarding.transition({ event: "complete", targetCode: "not-a-language" } as never),
      ).rejects.toThrow(/targetCode/)
      await expect(onboarding.transition({ event: "init" } as never)).rejects.toThrow(/event/)
      await expect(
        onboarding.transition({
          event: "complete",
          targetCode: "kor",
          retryCompletionOnly: "yes",
        } as never),
      ).rejects.toThrow(/retryCompletionOnly/)
      expect(writeCount(configKey)).toBe(0)
      expect(writeCount(onboardingKey)).toBe(0)

      const result = await onboarding.transition({ event: "dismiss" })
      expect(result).toEqual({ ok: true, status: "dismissed" })
    })
  })

  describe("message handler", () => {
    it("serves onboardingTransition through the worker-wide coordinator", async () => {
      await seedStatus("pending")
      setupOnboardingMessageHandlers()

      expect(onMessageMock).toHaveBeenCalledWith("onboardingTransition", expect.any(Function))
      const handler = onMessageMock.mock.calls[0]![1] as (message: {
        data: unknown
      }) => Promise<unknown>
      await expect(handler({ data: { event: "dismiss" } })).resolves.toEqual({
        ok: true,
        status: "dismissed",
      })
    })
  })
})
