// The page-translation mode shortcut over a stored config that cannot be used.
//
// The shortcut runs in the page and flips the mode with `setLocalConfig`. When the stored config
// cannot be validated, `getLocalConfig` returns the DEFAULTS, so the shortcut used to write defaults
// plus the flipped mode over the user's real settings, with no copy kept. The write is refused now,
// the original stays exactly as stored, the shortcut does not throw out of the page, and the user
// is told rather than left to think the shortcut did nothing.
//
// Real: `bindTranslationModeShortcutKey`, `getLocalConfig`, `setLocalConfig`, over the extension's
// in-memory browser storage. Replaced: the hotkey manager (to fire the registered handler by hand)
// and the toast manager (to read the messages).

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"

const { registerMock, toastAdd } = vi.hoisted(() => ({
  registerMock: vi.fn<(...args: any[]) => { unregister: () => void }>(),
  toastAdd: vi.fn<(options: Record<string, unknown>) => unknown>(),
}))

vi.mock("@tanstack/hotkeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/hotkeys")>()),
  HotkeyManager: { getInstance: () => ({ register: registerMock }) },
}))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: toastAdd } }))

const SWITCHED = "options.translation.preference.translationMode.switched"

async function pressTheShortcut() {
  vi.resetModules()
  const { bindTranslationModeShortcutKey } = await import("../bind-translation-mode-shortcut")
  await bindTranslationModeShortcutKey()
  const handler = registerMock.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined
  if (!handler) throw new Error("the shortcut was not registered")
  return handler()
}

function toastTitles() {
  return toastAdd.mock.calls.map(([options]) => String(options.title))
}

beforeEach(() => {
  resetStorage()
  registerMock.mockReset()
  registerMock.mockReturnValue({ unregister: () => {} })
  toastAdd.mockReset()
})

describe("the page-translation mode shortcut over a primary config that is not valid", () => {
  const SUSPECT: RawPrimary = { value: corruptConfig(), meta: CURRENT_META }

  beforeEach(async () => {
    await seedPrimary(SUSPECT.value, SUSPECT.meta)
  })

  it("leaves local:config and its meta exactly as stored", async () => {
    await pressTheShortcut().catch(() => undefined)

    expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
  })

  it("does not throw out of the page (a control)", async () => {
    await expect(pressTheShortcut()).resolves.toBeUndefined()
  })

  it("does not say the mode was switched, and says something instead", async () => {
    await pressTheShortcut().catch(() => undefined)

    expect(toastTitles().length).toBeGreaterThan(0)
    expect(toastTitles().some((title) => title.startsWith(SWITCHED))).toBe(false)
  })
})

describe("controls: the shortcut over a valid config", () => {
  it("flips the mode, keeps everything else, and says so", async () => {
    const config = validConfig()
    config.pageTranslation.mode = "bilingual"
    await seedPrimary(config, CURRENT_META)

    await pressTheShortcut()

    const stored = (await readRawPrimary()).value as typeof config
    expect(stored.pageTranslation.mode).toBe("translationOnly")
    expect(stored.language).toEqual(config.language)
    expect(toastTitles()).toEqual([SWITCHED])
  })
})
