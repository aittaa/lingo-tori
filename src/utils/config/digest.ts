/**
 * SHA-256 of a string as lowercase hex. Needs `crypto.subtle`, which extension pages and the
 * background have; a page-world content script on an insecure origin may not.
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("crypto.subtle is not available in this context")
  const bytes = new TextEncoder().encode(text)
  const digest = await subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
