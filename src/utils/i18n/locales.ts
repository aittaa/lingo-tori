// The UI locale list on its own, so code that only needs to know which
// languages exist does not load every translation (resources.ts imports all
// the locale files).

/**
 * The interface languages the runtime i18next engine can switch between.
 *
 * MUST stay in sync with the `uiLanguage` enum in `@/types/config/config` and the
 * files under `src/locales/`. `@wxt-dev/i18n/module` still reads those same files to
 * emit `_locales/*` for manifest name/description localization (browser-locale-bound).
 */
export const SUPPORTED_UI_LOCALES = ["en", "ko", "ja"] as const

export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: SupportedUiLocale = "en"
