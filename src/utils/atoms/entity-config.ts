import type { APIProviderConfig } from "@/types/config/provider"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { atom } from "jotai"
import { isAPIProviderConfig } from "@/types/config/provider"
import { findSelectionToolbarAction, replaceSelectionToolbarAction } from "@/utils/custom-actions"
import { syncLayoutSampleData } from "@/utils/layout-host/sample"
import { writeConfigAtom } from "./config"

// Not `async`, for the reason `writeConfigAtom` is not: the provider list's switch does not wait for
// this patch, and a wrapper that awaits the write and rethrows would hold the refusal in a promise
// of its own that nothing observes.
export const patchProviderConfigAtom = atom(
  null,
  (_get, set, { id, changes }: { id: string; changes: Partial<APIProviderConfig> }) =>
    set(writeConfigAtom, (current) => {
      const provider = current.providersConfig.find((item) => item.id === id)
      if (!provider || !isAPIProviderConfig(provider)) throw new Error("Provider no longer exists")
      const next = { ...provider, ...changes, id } as APIProviderConfig
      return {
        providersConfig: current.providersConfig.map((item) => (item.id === id ? next : item)),
      }
    }),
)

export const patchActionConfigAtom = atom(
  null,
  async (
    _get,
    set,
    { id, changes }: { id: string; changes: Partial<SelectionToolbarCustomAction> },
  ) => {
    await set(writeConfigAtom, (current) => {
      const action = findSelectionToolbarAction(current.selectionToolbar, id)
      if (!action) throw new Error("Action no longer exists")
      const patched = { ...action, ...changes, id }
      // The sample data follows the fields: a new field gets a sample value, a
      // removed field's goes. A built-in action's is dropped on replace.
      const next = {
        ...patched,
        sampleData: syncLayoutSampleData(
          patched.sampleData,
          patched.outputSchema,
          current.language.targetCode,
        ),
      }
      return { selectionToolbar: replaceSelectionToolbarAction(current.selectionToolbar, next) }
    })
  },
)
