import { atom } from "jotai"
// Compatibility for toolbar dismissal guards. Local saves require no account dialog.
export const isSaveToNotebaseDialogOpenAtom = atom(false)
