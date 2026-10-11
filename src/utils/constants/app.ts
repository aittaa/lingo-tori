import { browser } from "#imports"

export const APP_NAME = "LingoTori"
// Storage identity survives product renames; never derive it from the display name.
export const LEGACY_DATABASE_NAME = "ReadFrogDB"
const manifest = browser.runtime.getManifest()
export const EXTENSION_VERSION = manifest.version
