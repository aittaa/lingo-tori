# Language contracts provenance

This module was independently authored for this GPL extension. No implementation,
declarations, or data tables from `@read-frog/definitions` were inspected or copied.

- The 179 persisted language keys, ordering, English labels, and three learning
  levels are taken from this repository's GPL-licensed `src/locales/en.yml` and
  existing config call sites. `cmnHant` is represented by the persisted `cmn-Hant`.
- The short-code table is an independently written collection of standardized
  language-code facts. Reference: Library of Congress ISO 639-2/639-1 list,
  https://www.loc.gov/standards/iso639-2/php/code_list.php (accessed 2026-10-11).
  Individual variants use their macrolanguage's short code where applicable
  (for example Standard Arabic/Arabic, Iranian Persian/Persian, Mandarin/Chinese).
  Chinese `zh-CN` and `zh-TW` are compatibility provider tags rather than ISO 639-1
  codes. Languages without a short code remain selectable for LLM translation;
  providers requiring short codes reject them through existing validation.
- Native labels are produced at runtime by the browser's `Intl.DisplayNames`,
  https://tc39.es/ecma402/#sec-intl-displaynames-constructor. No third-party CLDR
  data is vendored. Unsupported locales fall back to the GPL English label.
- RTL membership is independently authored for the customary scripts of the
  supported target languages; it is not a claim that every script for a language
  has the same direction.

No dependency or separately licensed dataset is added. Module code is covered by
this repository's GPL license. Native labels may vary with browser ICU versions.
