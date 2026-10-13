// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  NETFLIX_LOAD_POST_MESSAGE_TIMEOUT_MS,
  NETFLIX_LOAD_TIMEOUT_MS,
  NETFLIX_SUBTITLES_REQUEST_TYPE,
  NETFLIX_SUBTITLES_RESPONSE_TYPE,
  POST_MESSAGE_TIMEOUT_MS,
} from "@/utils/constants/subtitles"
import { NetflixSubtitlesFetcher } from "@/utils/subtitles/fetchers/netflix"
import { listenForSubtitlesRequests } from "../player"

const capture = vi.hoisted(() => ({ ttml: null as string | null }))
vi.mock("../ttml-capture", () => ({ findCapturedTtml: () => capture.ttml }))

const TTML = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xml:lang="en">
<body><div><p begin="10000000t" end="20000000t">Hello there.</p></div></body>
</tt>`

const track = (trackId: string, bcp47: string | null, flags: Partial<{ none: boolean }> = {}) => ({
  trackId,
  bcp47,
  isNoneTrack: !!flags.none,
  isForcedNarrative: false,
})

const OFF = track("off", null, { none: true })
const ZH = track("zh-Hant", "zh-Hant")
const EN = track("en", "en")

let current = OFF
let playerReady = true
let movieId = 1

const player = {
  getMovieId: () => movieId,
  getAudioTrack: () => ({ bcp47: "zh-CN" }),
  getTimedTextTrack: () => current,
  getTimedTextTrackList: () => (playerReady ? [OFF, ZH, EN] : []),
  setTimedTextTrack: (next: typeof current) => {
    current = next
  },
}

beforeAll(() => {
  ;(window as any).netflix = {
    appContext: {
      state: {
        playerApp: {
          getAPI: () => ({
            videoPlayer: {
              getAllPlayerSessionIds: () => ["watch-1"],
              getVideoPlayerBySessionId: () => player,
            },
          }),
        },
      },
    },
  }
  listenForSubtitlesRequests()
})

beforeEach(() => {
  current = OFF
  playerReady = true
  movieId = 1
  // A watch URL naming the movie the player shows, as the page checks both before a change.
  window.history.pushState({}, "", "/watch/1")
  capture.ttml = TTML
  // jsdom posts messages without an origin, and both ends of the bridge check it.
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    setTimeout(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }))
    })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.history.pushState({}, "", "/")
})

interface Scope {
  operationId?: string
  operationIds?: string[]
  expectedMovieId?: string | null
}

// A request for the movie showing, from a load named "op-default" unless it says otherwise.
const DEFAULT_SCOPE: Scope = {
  expectedMovieId: "1",
  operationId: "op-default",
  operationIds: ["op-default"],
}

// `scope` says which request this is and which movie it is for, as the content script's does.
function request(action: "state" | "load" | "restore" | "cancel", scope: Scope = {}): Promise<any> {
  return new Promise((resolve) => {
    const requestId = Math.random().toString()
    const handler = (event: MessageEvent) => {
      if (
        event.data?.type === NETFLIX_SUBTITLES_RESPONSE_TYPE &&
        event.data.requestId === requestId
      ) {
        window.removeEventListener("message", handler)
        resolve(event.data)
      }
    }
    window.addEventListener("message", handler)
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: NETFLIX_SUBTITLES_REQUEST_TYPE,
          requestId,
          action,
          ...DEFAULT_SCOPE,
          ...scope,
        },
        origin: window.location.origin,
      }),
    )
  })
}

describe("Netflix player requests", () => {
  it("picks the audio-language track and puts Off back on restore", async () => {
    await expect(request("load")).resolves.toMatchObject({ trackId: "zh-Hant", ttml: TTML })

    await request("restore")

    expect(current).toBe(OFF)
  })

  it("keeps a track the viewer chose after Read Frog picked one", async () => {
    await request("load")
    current = EN
    await expect(request("load")).resolves.toMatchObject({ trackId: "en" })

    await request("restore")

    expect(current).toBe(EN)
  })

  it("still answers when reading the player throws", async () => {
    vi.spyOn(player, "getMovieId").mockImplementationOnce(() => {
      throw new Error("player torn down")
    })

    await expect(request("load")).resolves.toMatchObject({ movieId: null, ttml: null })
  })

  it("answers a state check before the content script's usual wait runs out", async () => {
    vi.useFakeTimers()
    playerReady = false
    const start = Date.now()
    let answeredAfterMs: number | undefined
    void request("state").then(() => {
      answeredAfterMs = Date.now() - start
    })

    await vi.advanceTimersByTimeAsync(POST_MESSAGE_TIMEOUT_MS)

    expect(answeredAfterMs).toBeLessThan(POST_MESSAGE_TIMEOUT_MS)
  })
})

describe("Netflix requests that wait for the player", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    playerReady = false
    window.history.pushState({}, "", "/watch/1")
  })

  afterEach(() => {
    window.history.pushState({}, "", "/")
  })

  // Lets the page's polling and the message hops run to the end.
  const settle = () => vi.advanceTimersByTimeAsync(1000)

  it("enables no track for a load given up before it arrived", async () => {
    const cancelled = request("cancel", { operationId: "op-early" })
    await settle()
    await cancelled

    const load = request("load", { operationId: "op-early", expectedMovieId: "1" })
    playerReady = true
    await settle()

    await expect(load).resolves.toMatchObject({ movieId: null, ttml: null })
    expect(current).toBe(OFF)
  })

  it("enables no track for a load given up while it waited for the player", async () => {
    const load = request("load", { operationId: "op-waiting", expectedMovieId: "1" })
    await vi.advanceTimersByTimeAsync(250)
    const cancelled = request("cancel", { operationId: "op-waiting" })
    await vi.advanceTimersByTimeAsync(250)
    await cancelled

    playerReady = true
    await settle()

    await expect(load).resolves.toMatchObject({ movieId: null, ttml: null })
    expect(current).toBe(OFF)
  })

  it("enables no track for a movie the page no longer shows, but loads one it does", async () => {
    const stale = request("load", { operationId: "op-stale", expectedMovieId: "9" })
    const wanted = request("load", { operationId: "op-wanted", expectedMovieId: "1" })
    playerReady = true
    await settle()

    await expect(stale).resolves.toMatchObject({ movieId: null, ttml: null })
    await expect(wanted).resolves.toMatchObject({ trackId: "zh-Hant", ttml: TTML })
  })

  it("answers a state check for any movie, because it only reads", async () => {
    playerReady = true
    const state = request("state", { expectedMovieId: "9" })
    await settle()

    await expect(state).resolves.toMatchObject({ movieId: 1, trackId: "off" })
  })

  it("keeps the restore record of the movie now showing when another movie's restore arrives", async () => {
    playerReady = true
    movieId = 2
    window.history.pushState({}, "", "/watch/2")
    const load = request("load", { operationId: "op-next", expectedMovieId: "2" })
    await settle()
    await load
    expect(current).toBe(ZH)

    // A restore made for the movie before, arriving late, is neither acted on nor allowed to spend
    // the record the next movie's load just made.
    const staleRestore = request("restore", { operationIds: ["op-next"], expectedMovieId: "1" })
    await settle()
    await staleRestore
    expect(current).toBe(ZH)

    const ownRestore = request("restore", { operationIds: ["op-next"], expectedMovieId: "2" })
    await settle()
    await ownRestore
    expect(current).toBe(OFF)
  })

  it("waits for the player to show the movie a request names, never running it against another title", async () => {
    window.history.pushState({}, "", "/watch/2")
    // Ready, but still on the movie before.
    playerReady = true
    let settled = false
    const load = request("load", { operationId: "op-title", expectedMovieId: "2" }).then(
      (reply) => {
        settled = true
        return reply
      },
    )

    await vi.advanceTimersByTimeAsync(3000)
    expect(settled).toBe(false)
    expect(current).toBe(OFF)

    movieId = 2
    await settle()
    await expect(load).resolves.toMatchObject({ movieId: 2, trackId: "zh-Hant", ttml: TTML })
  })

  it("returns without a change when the player never shows the movie a request names", async () => {
    window.history.pushState({}, "", "/watch/2")
    playerReady = true
    const load = request("load", { operationId: "op-never", expectedMovieId: "2" })

    await vi.advanceTimersByTimeAsync(NETFLIX_LOAD_TIMEOUT_MS + 1000)

    await expect(load).resolves.toMatchObject({ movieId: null, ttml: null })
    expect(current).toBe(OFF)
  })

  it("reports the movie the player really shows to a state check, whatever the URL says", async () => {
    window.history.pushState({}, "", "/watch/2")
    playerReady = true
    const state = request("state", { expectedMovieId: "2" })
    await settle()

    await expect(state).resolves.toMatchObject({ movieId: 1 })
  })

  it("refuses to change anything for a request that names no movie", async () => {
    playerReady = true
    const load = request("load", { expectedMovieId: undefined })
    await settle()

    await expect(load).resolves.toMatchObject({ movieId: null, ttml: null })
    expect(current).toBe(OFF)
  })

  describe("who owns the track a load replaced", () => {
    async function loadAs(operationId: string) {
      playerReady = true
      const load = request("load", { operationId, expectedMovieId: "1" })
      await settle()
      return load
    }
    async function restoreFor(operationIds: string[]) {
      const restore = request("restore", { operationIds, expectedMovieId: "1" })
      await settle()
      return restore
    }
    async function cancel(operationId: string) {
      const cancelled = request("cancel", { operationId })
      await settle()
      return cancelled
    }

    it("is put back by a restore that names the load that changed it", async () => {
      await loadAs("op-a")
      expect(current).toBe(ZH)

      await restoreFor(["op-b"])
      expect(current).toBe(ZH)

      await restoreFor(["op-b", "op-a"])
      expect(current).toBe(OFF)
    })

    it("is put back at cancel, while the player still shows the movie it was changed for", async () => {
      await loadAs("op-abandoned")
      expect(current).toBe(ZH)

      await cancel("op-abandoned")

      expect(current).toBe(OFF)
    })

    it("is not reached for at cancel once the player shows another movie, and the record is spent", async () => {
      await loadAs("op-moved")
      movieId = 2
      window.history.pushState({}, "", "/watch/2")

      await cancel("op-moved")
      expect(current).toBe(ZH)

      movieId = 1
      window.history.pushState({}, "", "/watch/1")
      await restoreFor(["op-moved"])
      expect(current).toBe(ZH)
    })

    it("is left to its newer owner when an older load is cancelled or restored late", async () => {
      await loadAs("op-old")
      await restoreFor(["op-old"])
      expect(current).toBe(OFF)

      await loadAs("op-new")
      expect(current).toBe(ZH)

      await cancel("op-old")
      await restoreFor(["op-old"])
      expect(current).toBe(ZH)

      await restoreFor(["op-new"])
      expect(current).toBe(OFF)
    })
  })
})

describe("Netflix subtitle loads from the fetcher to the page and back", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    playerReady = false
    capture.ttml = null
  })

  function playerReadyAt(ms: number) {
    setTimeout(() => {
      playerReady = true
    }, ms)
  }

  function fileCapturedAt(ms: number) {
    setTimeout(() => {
      capture.ttml = TTML
    }, ms)
  }

  // What the viewer ends up with, once the content script has waited as long as it ever will.
  async function load(): Promise<{ message: string; ms: number }> {
    const start = Date.now()
    const outcome = new NetflixSubtitlesFetcher()
      .fetch()
      .then(
        () => "loaded",
        (error: Error) => error.message,
      )
      .then((message) => ({ message, ms: Date.now() - start }))
    await vi.advanceTimersByTimeAsync(NETFLIX_LOAD_POST_MESSAGE_TIMEOUT_MS)
    return outcome
  }

  it("keeps waiting for a slow player and a late subtitle file", async () => {
    playerReadyAt(3000)
    fileCapturedAt(6500)

    const { message, ms } = await load()

    expect(message).toBe("loaded")
    expect(ms).toBeGreaterThan(POST_MESSAGE_TIMEOUT_MS)
  })

  it.each([500, 2000, 9000])(
    "reports a file that never arrives the same way when the player is ready at %i ms",
    async (readyAtMs) => {
      playerReadyAt(readyAtMs)

      const { message, ms } = await load()

      expect(message).toBe("subtitles.errors.trackFileNotLoaded")
      expect(ms).toBeGreaterThanOrEqual(NETFLIX_LOAD_TIMEOUT_MS)
      expect(ms).toBeLessThan(NETFLIX_LOAD_POST_MESSAGE_TIMEOUT_MS)
    },
  )

  it("hears from the page that the player never became ready, and reports a timeout", async () => {
    const { message, ms } = await load()

    expect(message).toBe("subtitles.errors.fetchSubTimeout")
    expect(ms).toBeGreaterThanOrEqual(NETFLIX_LOAD_TIMEOUT_MS)
    expect(ms).toBeLessThan(NETFLIX_LOAD_POST_MESSAGE_TIMEOUT_MS)
  })
})
