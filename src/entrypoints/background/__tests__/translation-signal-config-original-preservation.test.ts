// The detected-language handler's read of the stored config.
//
// The `reportDetectedPageLanguage` handler used to read `local:config` straight from storage. With a
// stored config that cannot be validated that rejected with a TypeError on every report when the
// broken part is what it reads (the auto-translate patterns), and auto-translated by the user's raw
// patterns when the broken part is somewhere else, while every validated reader saw the defaults.
// It reads the session's view now, so an invalid stored config behaves like the defaults (no
// patterns, no auto-translation, no throw) and the stored value is left alone.
//
// Real: the handler, `shouldEnableAutoTranslation`, the page-translation state, the storage helpers
// and the schema. Mocked: only the message transport, the iframe injection and the logger.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { browser } from "#imports"
import { configSchema } from "@/types/config/config"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"

const { sendMessageMock, onMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn<(...args: any[]) => any>(),
  onMessageMock: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", () => ({ onMessage: onMessageMock, sendMessage: sendMessageMock }))
vi.mock("../iframe-injection", () => ({
  injectHostContentIntoTabIframes: vi.fn<(...args: any[]) => any>(),
  injectHostContentIntoCurrentTabIframesAfterNodeTranslation: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("@/utils/logger", () => ({
  logger: {
    error: vi.fn<(...args: any[]) => any>(),
    warn: vi.fn<(...args: any[]) => any>(),
    info: vi.fn<(...args: any[]) => any>(),
  },
}))

const PAGE_URL = "https://example.com/articles/1"
const handlers = new Map<string, (msg: any) => any>()

function withPattern(config: any) {
  config.pageTranslation.page.autoTranslatePatterns = ["example.com"]
  return config
}

/** Invalid in the part this reader reads: the auto-translate patterns are a string, not a list. */
function invalidWhereTheReaderLooks(): any {
  const config = validConfig() as any
  config.pageTranslation.page.autoTranslatePatterns = "example.com"
  return config
}

/** Invalid in a part this reader never looks at, with the user's own auto-translate pattern. */
function invalidElsewhere(): any {
  return withPattern(corruptConfig())
}

async function reportLanguage() {
  const handler = handlers.get("reportDetectedPageLanguage")
  if (!handler) throw new Error("reportDetectedPageLanguage handler was not registered")
  return handler({
    data: { url: PAGE_URL, detectedCodeOrUnd: "eng" },
    sender: { tab: { id: 42 }, frameId: 0 },
  })
}

function autoTranslationWasRequested() {
  return sendMessageMock.mock.calls.some(
    ([name, data]) => name === "askManagerToTogglePageTranslation" && data?.enabled === true,
  )
}

describe("the detected-language handler's read of the stored config", () => {
  beforeEach(async () => {
    resetStorage()
    sendMessageMock.mockReset()
    sendMessageMock.mockResolvedValue(undefined)
    handlers.clear()
    onMessageMock.mockReset()
    onMessageMock.mockImplementation((name: string, handler: (msg: any) => any) => {
      handlers.set(name, handler)
      return vi.fn<(...args: any[]) => any>()
    })
    browser.tabs.query = vi.fn<(...args: any[]) => any>().mockResolvedValue([{ id: 42 }]) as any
    vi.resetModules()
    const { translationMessage } = await import("../translation-signal")
    translationMessage()
  })

  it("uses fixtures that fail the schema, and a valid one that does not", () => {
    expect(configSchema.safeParse(invalidWhereTheReaderLooks()).success).toBe(false)
    expect(configSchema.safeParse(invalidElsewhere()).success).toBe(false)
    expect(configSchema.safeParse(withPattern(validConfig())).success).toBe(true)
  })

  it("does not throw out of the message handler when the broken part is the one it reads", async () => {
    await seedPrimary(invalidWhereTheReaderLooks(), CURRENT_META)

    await expect(reportLanguage()).resolves.toBeUndefined()

    expect(autoTranslationWasRequested()).toBe(false)
  })

  it("stays quiet on every report while the value stays stored", async () => {
    await seedPrimary(invalidWhereTheReaderLooks(), CURRENT_META)

    for (let n = 0; n < 3; n++) {
      await expect(reportLanguage()).resolves.toBeUndefined()
    }
  })

  it("does not auto-translate by the user's raw patterns out of a config that fails validation", async () => {
    await seedPrimary(invalidElsewhere(), CURRENT_META)

    await reportLanguage()

    expect(autoTranslationWasRequested()).toBe(false)
  })

  it("leaves the stored value alone", async () => {
    await seedPrimary(invalidElsewhere(), CURRENT_META)
    const before = await readRawPrimary()

    await reportLanguage().catch(() => undefined)

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  describe("controls (a control)", () => {
    it("auto-translates a page that matches a pattern of a valid config", async () => {
      await seedPrimary(withPattern(validConfig()), CURRENT_META)

      await reportLanguage()

      expect(autoTranslationWasRequested()).toBe(true)
    })

    it("does nothing when nothing is stored", async () => {
      await reportLanguage()

      expect(autoTranslationWasRequested()).toBe(false)
    })
  })
})
