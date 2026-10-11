import { describe, expect, it } from "vitest"
import { parseYoutubeVideoId } from "../youtube"
describe("independent YouTube video ID parser", () => {
  it("handles public watch, short, embed and mobile URL forms", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://youtube.com/live/dQw4w9WgXcQ",
    ])
      expect(parseYoutubeVideoId(url)).toBe("dQw4w9WgXcQ")
  })
  it("rejects unrelated hosts, credentials, non-web URLs and malformed IDs", () => {
    for (const url of [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "https://youtube.com/watch?v=short",
      "https://youtu.be/",
      "not a URL",
    ])
      expect(parseYoutubeVideoId(url)).toBeNull()
  })
})
