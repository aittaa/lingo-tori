/**
 * Where the options page points to the privacy notice and the third-party notices.
 *
 * The privacy notice is the repository's own `docs/privacy.md`, read on GitHub, so the extension
 * ships no second copy that could drift from it. The URL resolves only once that file is on the
 * default branch. The third-party notices ship inside the extension (`public/`), because their
 * licenses ask for the notice to travel with each copy.
 */
export const PRIVACY_NOTICE_URL = "https://github.com/aittaa/lingo-tori/blob/main/docs/privacy.md"
export const THIRD_PARTY_NOTICES_PATH = "/THIRD_PARTY_NOTICES.txt"
