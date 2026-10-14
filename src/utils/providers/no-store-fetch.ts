/**
 * `fetch` for provider requests, which carry the user's text and the model's answer.
 *
 * `cache: "no-store"` keeps the response out of the browser's on-disk HTTP cache, where it
 * would outlive the page — and a private window. It wins over any `cache` the caller set: no
 * provider response is worth keeping there. `globalThis.fetch` is resolved per call so a
 * replaced global fetch is honored.
 */
export const noStoreFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, cache: "no-store" })
