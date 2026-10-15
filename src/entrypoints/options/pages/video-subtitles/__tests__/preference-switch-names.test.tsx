// @vitest-environment jsdom
// The three switches on the video subtitles page (subtitles enabled, auto-start, AI segmentation)
// sat beside a title and a description that were not tied to them, so each switch had an empty
// accessible name. The real page is mounted here, with the strings of the shipped EN, KO and JA
// catalogues, the real config atoms and the extension's in-memory browser storage.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"
import { VideoSubtitlesPage } from "../index"

// The strings are the shipped catalogues, parsed with the YAML parser the Vite plugin uses (the
// general test setup stubs the i18n facade to return keys). The facade itself is a plain lookup over
// them here: its i18next setup cannot load the YAML imports under jsdom.
const { i18nState, loadCatalogues } = vi.hoisted(() => ({
  i18nState: { locale: "en" },
  loadCatalogues: async () => {
    const { readFileSync } = await import("node:fs")
    const { createRequire } = await import("node:module")
    const { join } = await import("node:path")
    // Tests run from the project root; `import.meta.url` is not a file URL under jsdom.
    const requireFromRoot = createRequire(join(process.cwd(), "package.json"))
    const { load } = createRequire(requireFromRoot.resolve("@modyfi/vite-plugin-yaml"))("js-yaml")
    const read = (locale: string) =>
      load(readFileSync(join(process.cwd(), "src/locales", `${locale}.yml`), "utf8"))
    return { en: read("en"), ko: read("ko"), ja: read("ja") }
  },
}))

vi.mock("@/utils/i18n", async () => {
  const catalogues = await loadCatalogues()
  const lookup = (locale: string, key: string): string | undefined => {
    let node: unknown = (catalogues as Record<string, unknown>)[locale]
    for (const part of key.split(".")) {
      node = (node as Record<string, unknown> | undefined)?.[part]
    }
    return typeof node === "string" ? node : undefined
  }
  return {
    i18n: {
      t: (key: string) => lookup(i18nState.locale, key) ?? lookup("en", key) ?? "",
    },
    initI18n: async () => {},
    setUiLanguage: async () => {},
    getUiLocale: () => i18nState.locale,
    translateIn: (_locale: string, key: string) => lookup("en", key) ?? "",
  }
})

type SwitchField = "enabled" | "autoStart" | "aiSegmentation"

const DESCRIPTION_KEYS = {
  enabled: "options.videoSubtitles.preference.enable.description",
  autoStart: "options.videoSubtitles.preference.autoStart.description",
  aiSegmentation: "options.videoSubtitles.preference.aiSegmentation.description",
} as const

interface Row {
  field: SwitchField
  /** The row's title in the catalogue, i.e. what the switch has to be called. */
  name: string
  descriptionKey: (typeof DESCRIPTION_KEYS)[SwitchField]
}

const LOCALES: Array<readonly ["en" | "ko" | "ja", Row[]]> = [
  [
    "en",
    [
      {
        field: "enabled",
        name: "Enable video subtitles",
        descriptionKey: DESCRIPTION_KEYS.enabled,
      },
      {
        field: "autoStart",
        name: "Auto-translate videos in other languages",
        descriptionKey: DESCRIPTION_KEYS.autoStart,
      },
      {
        field: "aiSegmentation",
        name: "AI smart segmentation",
        descriptionKey: DESCRIPTION_KEYS.aiSegmentation,
      },
    ],
  ],
  [
    "ko",
    [
      { field: "enabled", name: "비디오 자막 켜기", descriptionKey: DESCRIPTION_KEYS.enabled },
      {
        field: "autoStart",
        name: "다른 언어 영상 자동 번역",
        descriptionKey: DESCRIPTION_KEYS.autoStart,
      },
      {
        field: "aiSegmentation",
        name: "AI 스마트 분할",
        descriptionKey: DESCRIPTION_KEYS.aiSegmentation,
      },
    ],
  ],
  [
    "ja",
    [
      { field: "enabled", name: "動画字幕を有効にする", descriptionKey: DESCRIPTION_KEYS.enabled },
      {
        field: "autoStart",
        name: "他の言語の動画を自動で翻訳",
        descriptionKey: DESCRIPTION_KEYS.autoStart,
      },
      {
        field: "aiSegmentation",
        name: "AI スマート区切り",
        descriptionKey: DESCRIPTION_KEYS.aiSegmentation,
      },
    ],
  ],
]

async function storedConfig() {
  const stored = await fakeBrowser.storage.local.get(CONFIG_STORAGE_KEY)
  return stored[CONFIG_STORAGE_KEY] as typeof DEFAULT_CONFIG | undefined
}

function renderPage() {
  const store = createStore()
  store.set(configAtom, DEFAULT_CONFIG)
  render(
    <MemoryRouter>
      <Provider store={store}>
        <VideoSubtitlesPage />
      </Provider>
    </MemoryRouter>,
  )
  return store
}

beforeEach(async () => {
  fakeBrowser.reset()
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: DEFAULT_CONFIG })
})

afterEach(() => {
  cleanup()
  i18nState.locale = "en"
})

describe.each(LOCALES)("video subtitles switches in %s", (locale, rows) => {
  beforeEach(() => {
    i18nState.locale = locale
  })

  it("renders the page in the language under test", () => {
    renderPage()

    expect(screen.getByText(rows[0]!.name)).toBeInTheDocument()
    expect(screen.getByText(rows[1]!.name)).toBeInTheDocument()
    expect(screen.getByText(rows[2]!.name)).toBeInTheDocument()
  })

  it.each([0, 1, 2])("finds switch %i by its title, and only that one", (index) => {
    renderPage()
    const { name } = rows[index]!

    const found = screen.getAllByRole("switch", { name })

    expect(found).toHaveLength(1)
    expect(screen.getByRole("switch", { name })).toBe(found[0])
  })

  it("leaves no unnamed switch on the page, and the three names differ", () => {
    renderPage()

    const switches = screen.getAllByRole("switch")
    const named = screen.getAllByRole("switch", { name: /\S/ })

    expect(switches).toHaveLength(3)
    expect(named).toHaveLength(switches.length)
    expect(new Set(rows.map((row) => row.name)).size).toBe(3)
  })

  it.each([0, 1, 2])("describes switch %i by its row's description", (index) => {
    renderPage()
    const row = rows[index]!

    expect(screen.getByRole("switch", { name: row.name })).toHaveAccessibleDescription(
      expect.stringContaining(i18n.t(row.descriptionKey)),
    )
  })

  it("writes each switch's own field and nothing else when it is toggled by its name", async () => {
    renderPage()
    const initial = structuredClone(DEFAULT_CONFIG)

    for (const { field, name } of rows) {
      fireEvent.click(screen.getByRole("switch", { name }))
      const expected = !initial.videoSubtitles[field]
      await waitFor(async () => {
        expect((await storedConfig())?.videoSubtitles[field]).toBe(expected)
      })
      // Back to where it started, so the next row is checked against the original config.
      fireEvent.click(screen.getByRole("switch", { name }))
      await waitFor(async () => {
        expect((await storedConfig())?.videoSubtitles[field]).toBe(initial.videoSubtitles[field])
      })
    }

    const final = await storedConfig()
    expect(final?.videoSubtitles).toEqual(initial.videoSubtitles)
    expect({ ...final, videoSubtitles: undefined }).toEqual({
      ...initial,
      videoSubtitles: undefined,
    })
  })
})
