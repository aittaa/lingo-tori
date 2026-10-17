// @vitest-environment jsdom
// The provider editor's assignment switches (a feature, language detection, a custom action) while
// the stored config cannot be used.
//
// A switch starts its write and does not wait for it, so the write's rejection has no caller to
// receive it: the refusal must not reach the page as an uncaught error. A caller that does wait
// (the editor's actions are part of its context) must still get the typed rejection.
//
// Real: `ProviderEditor` and `CustomProviderEditor.Provider` with their assignment rows, the config
// atoms and the extension's in-memory browser storage. The process's own `unhandledRejection` event
// (what a page reports as an uncaught error) is read, not a spy on the code under test.

import type { RawPrimary } from "@/utils/config/__tests__/preservation-test-kit"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { isAPIProviderConfig } from "@/types/config/provider"
import { configAtom, writeConfigAtom } from "@/utils/atoms/config"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  validConfig,
  watchUnhandledRejections,
} from "@/utils/config/__tests__/preservation-test-kit"
import { FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { getSelectionToolbarActions } from "@/utils/custom-actions"
import { CustomProviderEditor, ProviderEditor, useProviderEditor } from "../provider-editor"

type ProviderEditorActions = ReturnType<typeof useProviderEditor>["actions"]

const SUSPECT: RawPrimary = { value: corruptConfig("unusable"), meta: CURRENT_META }

// The editor was open for this provider when the stored config stopped being usable.
const shown = validConfig().providersConfig.find(isAPIProviderConfig)!

let unhandled: ReturnType<typeof watchUnhandledRejections>
let store: ReturnType<typeof createStore>

beforeEach(() => {
  resetStorage()
  store = createStore()
  unhandled = watchUnhandledRejections()
})

afterEach(() => {
  cleanup()
  unhandled.stop()
})

function renderEditor(children: React.ReactNode) {
  render(
    <ThemeProvider>
      <Provider store={store}>
        <CustomProviderEditor.Provider
          providerConfig={shown}
          form={{} as never}
          duplicate={async () => {}}
          delete={async () => {}}
        >
          {children}
        </CustomProviderEditor.Provider>
      </Provider>
    </ThemeProvider>,
  )
}

/** Hands the editor's actions to the test, for the callers that wait for them. */
function ActionsProbe({ onActions }: { onActions: (actions: ProviderEditorActions) => void }) {
  const { actions } = useProviderEditor()
  useEffect(() => {
    onActions(actions)
  }, [actions, onActions])
  return null
}

/** A write that is waited for queues behind every write started before it, so it settles after them. */
function queuedBehind() {
  return store.set(writeConfigAtom, {}).catch(() => undefined)
}

const ASSIGNMENTS = [
  {
    name: "a feature",
    row: <ProviderEditor.FeatureAssignment featureKey="pageTranslation" />,
    assign: (actions: ProviderEditorActions) => actions.assignFeature("pageTranslation"),
  },
  {
    name: "language detection",
    row: <ProviderEditor.LanguageDetectionAssignment />,
    assign: (actions: ProviderEditorActions) => actions.assignLanguageDetection(),
  },
  {
    name: "a custom action",
    row: <ProviderEditor.CustomActionAssignments />,
    assign: (actions: ProviderEditorActions) =>
      actions.assignCustomAction(
        getSelectionToolbarActions(store.get(configAtom).selectionToolbar)[0]!.id,
      ),
  },
]

describe.each(ASSIGNMENTS)("assigning $name to the provider", ({ row, assign }) => {
  describe("over a stored config that cannot be used", () => {
    beforeEach(async () => {
      await seedPrimary(SUSPECT.value, SUSPECT.meta)
    })

    it("by a switch that nothing waits for reaches the page as no unhandled rejection", async () => {
      renderEditor(row)
      const toggle = screen.getAllByRole("switch")[0]!
      expect(toggle.getAttribute("aria-checked")).toBe("false")

      fireEvent.click(toggle)
      // The write has been started: the switch shows the assignment before it is refused.
      expect(toggle.getAttribute("aria-checked")).toBe("true")
      await queuedBehind()
      await unhandled.flush()

      expect(unhandled.reasons).toEqual([])
    })

    it("stores nothing", async () => {
      renderEditor(row)

      fireEvent.click(screen.getAllByRole("switch")[0]!)
      await queuedBehind()
      await unhandled.flush()

      expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
    })

    it("rejects the action that is waited for with the typed refusal", async () => {
      let actions!: ProviderEditorActions
      renderEditor(
        <ActionsProbe
          onActions={(found) => {
            actions = found
          }}
        />,
      )

      await expect(assign(actions)).rejects.toMatchObject({ name: "ConfigRecoveryRequiredError" })
      await unhandled.flush()

      expect(unhandled.reasons).toEqual([])
      expect(sameRaw(await readRawPrimary(), SUSPECT)).toBe(true)
    })
  })
})

describe("control: assigning a feature to the provider over a stored config that can be used", () => {
  it("by a switch that nothing waits for stores the provider as the feature's provider, with nothing unhandled", async () => {
    await seedPrimary(validConfig(), CURRENT_META)
    store.set(configAtom, validConfig())
    renderEditor(<ProviderEditor.FeatureAssignment featureKey="pageTranslation" />)

    fireEvent.click(screen.getByRole("switch"))
    await queuedBehind()
    await unhandled.flush()

    const stored = (await readRawPrimary()).value as ReturnType<typeof validConfig>
    expect(FEATURE_PROVIDER_DEFS.pageTranslation.getProviderId(stored)).toBe(shown.id)
    expect(unhandled.reasons).toEqual([])
  })
})
