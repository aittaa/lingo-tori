// @vitest-environment jsdom
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { StrictMode } from "react"
import { createMemoryRouter, Link, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { AutosaveNavigation } from "@/components/form/autosave-navigation"
import { ToastProvider } from "@/components/ui/base-ui/toast"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configSchema } from "@/types/config/config"
import { selectionToolbarCustomActionSchema } from "@/types/config/selection-toolbar"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { CustomActionConfigForm } from ".."
import { selectedCustomActionIdAtom } from "../../atoms"

// Keep remote discovery/auth out of this test. The schema editor, parent form,
// validation, autosave controller, entity writer and navigation are all real.
vi.mock("../provider-field", () => ({ ProviderField: () => null }))
vi.mock("../notebase-connection-field", () => ({ NotebaseConnectionField: () => null }))
// The layout's CodeMirror editor and shadow-DOM preview are verified in a browser; the rename
// and delete paths below only touch the form's `layout` value.
vi.mock("../layout-field", () => ({ LayoutField: () => null, ReadOnlyLayoutField: () => null }))

function createAction(): SelectionToolbarCustomAction {
  return {
    id: "mapped-action",
    name: "Vocabulary",
    icon: "tabler:book",
    providerId: "unconfigured",
    systemPrompt: "Explain the selected text.",
    prompt: "{{selection}}",
    outputSchema: ["meaning", "example"].map((id) => ({
      id,
      name: id,
      type: "string",
      description: id,
    })),
    sampleData: {
      selection: "A word",
      targetCode: "eng",
      values: { meaning: "Its meaning", example: "An example" },
    },
  }
}

async function setup(action: SelectionToolbarCustomAction) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.selectionToolbar.customActions = [action]
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  await store.set(selectedCustomActionIdAtom, action.id)
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <AutosaveNavigation />
          <CustomActionConfigForm />
          <Link to="/done">Leave editor</Link>
        </>
      ),
    },
    { path: "/done", element: <p>Left editor</p> },
  ])
  render(
    <StrictMode>
      <Provider store={store}>
        <ToastProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </ToastProvider>
      </Provider>
    </StrictMode>,
  )
  return { router, store }
}

async function deleteMeaning() {
  const row = screen.getByText("meaning", { selector: "span.font-medium" }).parentElement!
  const deleteButton = within(row).getAllByRole("button")[1]!
  fireEvent.click(deleteButton)
  const dialog = await screen.findByRole("alertdialog")
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "options.selectionToolbar.customActions.form.deleteFieldDialog.confirm",
    }),
  )
}

async function renameMeaning(to: string) {
  const row = screen.getByText("meaning", { selector: "span.font-medium" }).parentElement!
  fireEvent.click(within(row).getAllByRole("button")[0]!)
  const dialog = await screen.findByRole("dialog")
  fireEvent.change(within(dialog).getAllByRole("textbox")[0]!, { target: { value: to } })
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "options.selectionToolbar.customActions.form.editFieldDialog.save",
    }),
  )
}

async function getPersistedAction(): Promise<SelectionToolbarCustomAction> {
  const stored = await fakeBrowser.storage.local.get(CONFIG_STORAGE_KEY)
  return configSchema.parse(stored[CONFIG_STORAGE_KEY]).selectionToolbar.customActions[0]!
}

describe("output schema autosave", () => {
  afterEach(() => vi.restoreAllMocks())
  it("persists field deletion and removes sample data before form validation", async () => {
    const action = createAction()
    const { router, store } = await setup(action)
    const writes = vi.spyOn(fakeBrowser.storage.local, "set")
    const expected: SelectionToolbarCustomAction = {
      ...action,
      outputSchema: [action.outputSchema[1]!],
      // The deleted field's sample value goes in the same write.
      sampleData: { ...action.sampleData!, values: { example: "An example" } },
    }

    await deleteMeaning()

    await waitFor(async () => expect(await getPersistedAction()).toEqual(expected))
    expect(selectionToolbarCustomActionSchema.safeParse(await getPersistedAction()).success).toBe(
      true,
    )
    expect(store.get(configAtom).selectionToolbar.customActions[0]).toEqual(expected)
    const configWrites = writes.mock.calls.filter(([items]) =>
      Object.hasOwn(items, CONFIG_STORAGE_KEY),
    )
    expect(configWrites).toHaveLength(1)
    expect(configWrites[0]![0]).toMatchObject({
      [CONFIG_STORAGE_KEY]: { selectionToolbar: { customActions: [expected] } },
    })

    fireEvent.click(screen.getByRole("link", { name: "Leave editor" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/done"))
    expect(screen.queryByText("options.autosave.leaveTitle")).not.toBeInTheDocument()
  })

  it("preserves the remaining field when deleting a field", async () => {
    const action = createAction()
    await setup(action)

    await deleteMeaning()

    await waitFor(async () =>
      expect((await getPersistedAction()).outputSchema).toEqual([action.outputSchema[1]!]),
    )
  })

  it("deletes a field without legacy sample data", async () => {
    const action = createAction()
    await setup(action)

    await deleteMeaning()

    await waitFor(async () =>
      expect((await getPersistedAction()).outputSchema).toEqual([action.outputSchema[1]!]),
    )
  })

  it("preserves inert legacy layout while saving a field rename", async () => {
    const action = createAction()
    action.layout =
      '<p>{{ meaning }}</p>{% if ["meaning"] != blank %}<i>{{ example | upcase }}</i>{% endif %}'
    await setup(action)
    const writes = vi.spyOn(fakeBrowser.storage.local, "set")

    await renameMeaning("definition")

    await waitFor(async () =>
      expect((await getPersistedAction()).outputSchema[0]!.name).toBe("definition"),
    )
    const expectedLayout = action.layout
    expect((await getPersistedAction()).layout).toBe(expectedLayout)
    const configWrites = writes.mock.calls.filter(([items]) =>
      Object.hasOwn(items, CONFIG_STORAGE_KEY),
    )
    expect(configWrites).toHaveLength(1)
    expect(configWrites[0]![0]).toMatchObject({
      [CONFIG_STORAGE_KEY]: {
        selectionToolbar: {
          customActions: [
            {
              layout: expectedLayout,
              outputSchema: [expect.objectContaining({ name: "definition" }), expect.anything()],
            },
          ],
        },
      },
    })
  })

  it("preserves inert layout locals when renaming fields", async () => {
    const action = createAction()
    // `definition` is a template local, so a moved reference would read it instead.
    action.layout = '{% assign definition = "x" %}{{ meaning }} {{ definition }}'
    await setup(action)

    await renameMeaning("definition")

    await waitFor(async () =>
      expect((await getPersistedAction()).outputSchema[0]!.name).toBe("definition"),
    )
    expect((await getPersistedAction()).layout).toBe(action.layout)
    expect(
      screen.queryByText("options.selectionToolbar.customActions.form.layout.renameSkipped"),
    ).not.toBeInTheDocument()
  })

  it("leaves the layout untouched when a field is deleted", async () => {
    const action = createAction()
    action.layout = "<p>{{ meaning }}</p><p>{{ example }}</p>"
    await setup(action)

    await deleteMeaning()

    await waitFor(async () =>
      expect((await getPersistedAction()).outputSchema).toEqual([action.outputSchema[1]!]),
    )
    expect((await getPersistedAction()).layout).toBe(action.layout)
  })
})
