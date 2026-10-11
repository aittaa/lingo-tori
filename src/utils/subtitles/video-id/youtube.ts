/** Independently authored parser for YouTube's public watch/share URL forms. */
export function parseYoutubeVideoId(value: string): string | null {
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null
    let candidate: string | null = null
    if (url.hostname === "youtu.be") candidate = url.pathname.split("/")[1] ?? null
    else if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "www.youtube-nocookie.com",
        "youtube-nocookie.com",
      ].includes(url.hostname)
    ) {
      const parts = url.pathname.split("/")
      candidate =
        url.pathname === "/watch"
          ? url.searchParams.get("v")
          : ["embed", "shorts", "live", "v"].includes(parts[1] ?? "")
            ? (parts[2] ?? null)
            : null
    }
    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null
  } catch {
    return null
  }
}
export function getYoutubeVideoId(): string | null {
  return parseYoutubeVideoId(window.location.href)
}
