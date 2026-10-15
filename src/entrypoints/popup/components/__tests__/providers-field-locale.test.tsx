// @vitest-environment jsdom
// The popup's "Providers" row: its title, its help text and the accessible name of the button that
// opens the provider drawer. In KO and JA all three were still English. The real component is
// mounted with the strings of the shipped catalogues.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import ProvidersField from "../providers-field"

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

vi.mock("@/components/providers/theme-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/providers/theme-provider")>()),
  useTheme: () => ({ theme: "light", setTheme: () => {} }),
}))

const EXPECTED = {
  en: {
    title: "Providers",
    help: "Choose which provider to use for each feature",
    open: "Open provider settings",
  },
  ko: {
    title: "제공업체",
    help: "각 기능에 사용할 제공업체를 선택하세요",
    open: "제공업체 설정 열기",
  },
  ja: {
    title: "プロバイダー",
    help: "各機能で使用するプロバイダーを選択します",
    open: "プロバイダー設定を開く",
  },
} as const

function renderField() {
  const store = createStore()
  store.set(configAtom, DEFAULT_CONFIG)
  render(
    <Provider store={store}>
      <TooltipProvider>
        <ProvidersField />
      </TooltipProvider>
    </Provider>,
  )
}

beforeEach(async () => {
  fakeBrowser.reset()
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: DEFAULT_CONFIG })
})

afterEach(() => {
  cleanup()
  i18nState.locale = "en"
})

describe.each(["en", "ko", "ja"] as const)("the popup provider row in %s", (locale) => {
  beforeEach(() => {
    i18nState.locale = locale
  })

  it("shows the row's title in that language", () => {
    renderField()

    expect(screen.getByText(EXPECTED[locale].title)).toBeInTheDocument()
  })

  it("names the button that opens the provider drawer in that language", () => {
    renderField()

    const button = screen.getByRole("button", { name: EXPECTED[locale].open })

    expect(button).toBeEnabled()
    expect(screen.getAllByRole("button", { name: EXPECTED[locale].open })).toHaveLength(1)
  })

  it("explains the row in that language when the help is opened", async () => {
    renderField()
    const trigger = document.querySelector("[data-slot=tooltip-trigger]")!

    fireEvent.mouseEnter(trigger)
    fireEvent.mouseMove(trigger, { clientX: 1, clientY: 1 })

    await waitFor(() => {
      expect(document.querySelector("[data-slot=tooltip-content][data-open]")).toHaveTextContent(
        EXPECTED[locale].help,
      )
    })
  })
})
