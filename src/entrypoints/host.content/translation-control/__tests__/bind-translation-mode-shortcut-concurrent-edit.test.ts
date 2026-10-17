// The page-translation mode shortcut while another context changes the settings.
//
// The shortcut runs in the page. It used to read the config, build the whole next config from it
// and store that, so a setting another context changed in between (the floating button's lock, for
// example) was put back to the value the shortcut had read, and the translation-only check was made
// against that older config. The shortcut now describes its change as an edit: the next mode, and
// whether it is allowed, are worked out from the config the settings service compares against, and
// again from the fresh one when the service says the data changed meanwhile.
//
// Real: `bindTranslationModeShortcutKey`, `getLocalConfig`, `editConfig`, the settings service with
// the admission of a content script, over the extension's in-memory browser storage. Replaced: the
// hotkey manager (to fire the registered handler by hand), the toast manager (to read the messages)
// and, in one test, the translation-only check (to make a config ineligible by one visible field).

import type { SenderEnvironment, SenderInfo } from "@/entrypoints/background/config-commit-service"
import type { Config } from "@/types/config/config"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  committedMeta,
  holdFirstResult,
  readRawPrimary,
  resetStorage,
  seedPrimary,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"
import { editConfig } from "@/utils/config/write-guard"

const { registerMock, toastAdd, blockedReason } = vi.hoisted(() => ({
  registerMock: vi.fn<(...args: any[]) => { unregister: () => void }>(),
  toastAdd: vi.fn<(options: Record<string, unknown>) => unknown>(),
  blockedReason: vi.fn<(config: Config) => string | null>(() => null),
}))

vi.mock("@tanstack/hotkeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/hotkeys")>()),
  HotkeyManager: { getInstance: () => ({ register: registerMock }) },
}))
vi.mock("@/components/ui/base-ui/toast", () => ({ toastManager: { add: toastAdd } }))
vi.mock("@/utils/providers/translation-only-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/providers/translation-only-gate")>()),
  getTranslationOnlyBlockedReason: blockedReason,
}))

const SWITCHED = "options.translation.preference.translationMode.switched"
const BLOCKED = "translation-only is not available for this config"

const EXTENSION_ID = "test-extension-id"
const ENVIRONMENT: SenderEnvironment = {
  extensionId: EXTENSION_ID,
  getUrl: () => `chrome-extension://${EXTENSION_ID}/`,
}
const CONTENT_SCRIPT: SenderInfo = {
  id: EXTENSION_ID,
  url: "https://example.com/page",
  tab: { id: 7 },
}

async function bindTheShortcut() {
  vi.resetModules()
  const { bindTranslationModeShortcutKey } = await import("../bind-translation-mode-shortcut")
  await bindTranslationModeShortcutKey()
  const handler = registerMock.mock.calls.at(-1)?.[1] as (() => Promise<void>) | undefined
  if (!handler) throw new Error("the shortcut was not registered")
  return handler
}

function toastTitles() {
  return toastAdd.mock.calls.map(([options]) => String(options.title))
}

function lockTheFloatingButton(config: Config): Config {
  return { ...config, floatingButton: { ...config.floatingButton, locked: true } }
}

function stored() {
  return readRawPrimary().then(({ value }) => value as Config)
}

async function seedBilingualConfig() {
  const config = validConfig()
  config.pageTranslation.mode = "bilingual"
  config.floatingButton.locked = false
  config.contextMenu.enabled = true
  await seedPrimary(config, committedMeta(config))
  return config
}

beforeEach(() => {
  resetStorage()
  registerMock.mockReset()
  registerMock.mockReturnValue({ unregister: () => {} })
  toastAdd.mockReset()
  blockedReason.mockReset()
  blockedReason.mockReturnValue(null)
})

describe("the mode shortcut while another context changes the settings", () => {
  it("keeps a setting that another context committed after the shortcut read the config", async () => {
    await seedBilingualConfig()
    const press = await bindTheShortcut()
    const read = holdFirstResult((keys) => keys.includes("config"))

    const pressed = press()
    await read.reached
    await editConfig(lockTheFloatingButton)
    read.release()
    await pressed

    const after = await stored()
    expect(after.pageTranslation.mode).toBe("translationOnly")
    expect(after.floatingButton.locked).toBe(true)
    expect(toastTitles()).toEqual([SWITCHED])
  })

  it("computes the mode again from the fresh config when the data changed while the edit was on its way", async () => {
    await seedBilingualConfig()
    vi.resetModules()
    const protocol = await import("@/utils/config/commit-protocol")
    const { createConfigCommitService } =
      await import("@/entrypoints/background/config-commit-service")
    const service = createConfigCommitService({ bootstrap: () => Promise.resolve() }, ENVIRONMENT)
    const { editConfig: editFromTheSameContext } = await import("@/utils/config/write-guard")
    let delayed = false
    protocol.setInProcessCommitHandler(async (request) => {
      if (!delayed && request.kind === "edit") {
        // Another context's change reaches the service before the shortcut's edit does.
        delayed = true
        await editFromTheSameContext(lockTheFloatingButton)
      }
      return service.handle(request, CONTENT_SCRIPT)
    })
    try {
      const { bindTranslationModeShortcutKey } = await import("../bind-translation-mode-shortcut")
      await bindTranslationModeShortcutKey()
      const press = registerMock.mock.calls.at(-1)?.[1] as () => Promise<void>

      await press()
    } finally {
      protocol.setInProcessCommitHandler(undefined)
    }

    const after = await stored()
    expect(delayed).toBe(true)
    expect(after.pageTranslation.mode).toBe("translationOnly")
    expect(after.floatingButton.locked).toBe(true)
  })

  it("checks whether translation-only is allowed against the config the edit is computed from", async () => {
    await seedBilingualConfig()
    blockedReason.mockImplementation((config) => (config.contextMenu.enabled ? null : BLOCKED))
    const press = await bindTheShortcut()
    const read = holdFirstResult((keys) => keys.includes("config"))

    const pressed = press()
    await read.reached
    // The config the shortcut read was eligible; the one stored now is not.
    await editConfig((config) => ({ ...config, contextMenu: { enabled: false } }))
    read.release()
    await pressed

    const after = await stored()
    expect(after.pageTranslation.mode).toBe("bilingual")
    expect(toastTitles()).toEqual([BLOCKED])
  })

  it("still tells the user when the change is refused (a control)", async () => {
    await seedBilingualConfig()
    const press = await bindTheShortcut()
    vi.spyOn(
      (await import("wxt/testing/fake-browser")).fakeBrowser.storage.local,
      "set" as any,
    ).mockRejectedValue(new Error("simulated write failure"))

    await expect(press()).resolves.toBeUndefined()

    expect(toastTitles()).toHaveLength(1)
    expect(toastTitles()[0]).not.toContain(SWITCHED)
  })
})
