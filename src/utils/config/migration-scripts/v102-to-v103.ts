/**
 * LingoTori provenance exception: this historical step contained frozen
 * proprietary preset strings. Replace it independently rather than shipping
 * those strings. Keep the version-chain slot and all non-layout user settings.
 * No shared imports: this remains a self-contained compatibility snapshot.
 */
export function migrate(oldConfig: any): any {
  if (!oldConfig || typeof oldConfig !== "object" || Array.isArray(oldConfig)) return oldConfig
  const toolbar = oldConfig.selectionToolbar
  if (!toolbar || typeof toolbar !== "object" || Array.isArray(toolbar)) return oldConfig
  if (!Array.isArray(toolbar.customActions)) return oldConfig
  return {
    ...oldConfig,
    selectionToolbar: {
      ...toolbar,
      customActions: toolbar.customActions.map((action: any) => {
        if (!action || typeof action !== "object" || Array.isArray(action)) return action
        const next = { ...action }
        delete next.layout
        // Old speech flags have no behavior in LingoTori; do not generate templates.
        if (Array.isArray(next.outputSchema)) {
          next.outputSchema = next.outputSchema.map((field: any) => {
            if (!field || typeof field !== "object" || Array.isArray(field)) return field
            const nextField = { ...field }
            delete nextField.speaking
            return nextField
          })
        }
        return next
      }),
    },
  }
}
