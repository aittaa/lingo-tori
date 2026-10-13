// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ENSURE_SUBTITLES_REQUEST_TYPE,
  ENSURE_SUBTITLES_RESPONSE_TYPE,
} from "@/utils/constants/subtitles"
import { injectPlayerApi } from "../inject-player-api"

// The page's caption bridge, driven through the messages the content script sends it. The state it
// keeps between messages outlives a test, so each test names videos and fetches of its own.
let shownVideoId = "vid-1"
let pressed = false
let toggleCaptions: ReturnType<typeof vi.fn<() => void>>
let postMessage: { mock: { calls: unknown[][] } }
let button: HTMLButtonElement

beforeAll(() => {
  injectPlayerApi()
})

beforeEach(() => {
  pressed = false
  shownVideoId = "vid-1"
  document.body.innerHTML =
    '<div class="html5-video-player"><button class="ytp-subtitles-button" aria-pressed="false"></button></div>'
  button = document.querySelector<HTMLButtonElement>(".ytp-subtitles-button")!
  const player = document.querySelector<HTMLElement>(".html5-video-player") as HTMLElement & {
    getPlayerResponse: () => unknown
    toggleSubtitles: () => void
  }
  player.getPlayerResponse = () => ({ videoDetails: { videoId: shownVideoId } })
  toggleCaptions = vi.fn<() => void>(() => {
    setPressed(!pressed)
  })
  player.toggleSubtitles = toggleCaptions
  postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

function setPressed(next: boolean) {
  pressed = next
  button.setAttribute("aria-pressed", String(next))
}

let nextRequest = 0
function send(fields: Record<string, unknown>): string {
  const requestId = `request-${++nextRequest}`
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: window.location.origin,
      data: { type: ENSURE_SUBTITLES_REQUEST_TYPE, requestId, ...fields },
    }),
  )
  return requestId
}

const answered = (requestId: string) =>
  postMessage.mock.calls.some(
    ([data]) =>
      (data as { type?: string; requestId?: string }).type === ENSURE_SUBTITLES_RESPONSE_TYPE &&
      (data as { requestId?: string }).requestId === requestId,
  )

// A probe's ensure and the restore that names it.
const probe = (videoId: string, operationId: string) =>
  send({ action: "ensure", expectedVideoId: videoId, operationId, probe: true })
const restore = (videoId: string, operationId: string) =>
  send({ action: "restore", expectedVideoId: videoId, operationId })

describe("the page's caption bridge", () => {
  it("switches the captions on for the video the player shows, and answers", () => {
    const requestId = send({ action: "ensure", expectedVideoId: "vid-1", operationId: "op-1" })

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
    expect(answered(requestId)).toBe(true)
  })

  it("leaves the captions alone for a video the player no longer shows, and still answers", () => {
    shownVideoId = "vid-2"

    const requestId = send({ action: "ensure", expectedVideoId: "vid-1", operationId: "op-1" })

    expect(toggleCaptions).not.toHaveBeenCalled()
    expect(answered(requestId)).toBe(true)
  })

  it("refuses a request that names no video", () => {
    send({ action: "ensure", operationId: "op-1" })
    send({})

    expect(toggleCaptions).not.toHaveBeenCalled()
  })

  it("ignores a request whose operation was given up before the request arrived", () => {
    send({ action: "cancel", operationId: "op-given-up" })

    send({ action: "ensure", expectedVideoId: "vid-1", operationId: "op-given-up" })
    expect(toggleCaptions).not.toHaveBeenCalled()

    send({ action: "ensure", expectedVideoId: "vid-1", operationId: "op-other" })
    expect(toggleCaptions).toHaveBeenCalledOnce()
  })

  it("does not switch on captions that are already on", () => {
    setPressed(true)

    probe("vid-1", "op-on")

    expect(toggleCaptions).not.toHaveBeenCalled()
    // Nothing was changed, so there is nothing of the probe's to put back.
    restore("vid-1", "op-on")
    expect(toggleCaptions).not.toHaveBeenCalled()
    expect(pressed).toBe(true)
  })

  it("puts back what a probe switched on, once", () => {
    shownVideoId = "vid-3"
    probe("vid-3", "op-3")
    expect(pressed).toBe(true)

    restore("vid-3", "op-3")
    expect(pressed).toBe(false)
    expect(toggleCaptions).toHaveBeenCalledTimes(2)

    // The record is spent: a second restore must not switch anything.
    setPressed(true)
    restore("vid-3", "op-3")
    expect(toggleCaptions).toHaveBeenCalledTimes(2)
    expect(pressed).toBe(true)
  })

  it("keeps a probe's record for the restore that names its own video", () => {
    shownVideoId = "vid-4"
    probe("vid-4", "op-4")

    // Another video's restore is not this record's to act on, nor to spend.
    restore("vid-elsewhere", "op-4")
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)

    restore("vid-4", "op-4")
    expect(pressed).toBe(false)
  })

  it("does not undo a viewer's switch-off", () => {
    shownVideoId = "vid-5"
    probe("vid-5", "op-5")
    setPressed(false)

    restore("vid-5", "op-5")

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(false)
  })

  it("does not touch a player that has moved on to another video, and spends the record", () => {
    shownVideoId = "vid-6"
    probe("vid-6", "op-6")
    shownVideoId = "vid-7"

    restore("vid-6", "op-6")
    expect(toggleCaptions).toHaveBeenCalledOnce()

    shownVideoId = "vid-6"
    restore("vid-6", "op-6")
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })

  it("lets the viewer's own flow take over a probe's change", () => {
    shownVideoId = "vid-8"
    probe("vid-8", "op-probe")
    expect(pressed).toBe(true)

    // A manual start or a transcript load asks for the captions too, and keeps them.
    send({ action: "ensure", expectedVideoId: "vid-8", operationId: "op-manual", probe: false })
    restore("vid-8", "op-probe")

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })
})

describe("who owns what a probe switched on", () => {
  it("acts on a restore only for the fetch that made the change, and keeps the record otherwise", () => {
    shownVideoId = "vid-10"
    probe("vid-10", "op-owner")

    restore("vid-10", "op-someone-else")
    send({ action: "restore", expectedVideoId: "vid-10" })
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)

    restore("vid-10", "op-owner")
    expect(pressed).toBe(false)
  })

  it("never lets an old restore clear a newer probe's record on the same video", () => {
    shownVideoId = "vid-11"
    probe("vid-11", "op-old")
    restore("vid-11", "op-old")
    expect(pressed).toBe(false)

    probe("vid-11", "op-new")
    expect(pressed).toBe(true)

    // The old restore, still on its way, arrives now.
    restore("vid-11", "op-old")
    expect(pressed).toBe(true)
    expect(toggleCaptions).toHaveBeenCalledTimes(3)

    restore("vid-11", "op-new")
    expect(pressed).toBe(false)
  })

  it("lets a claim hand a probe's change to an accepted session", () => {
    shownVideoId = "vid-12"
    probe("vid-12", "op-accepted")

    send({ action: "claim", operationIds: ["op-accepted"] })
    // The probe's own restore, late or queued, finds nothing of its to undo.
    restore("vid-12", "op-accepted")

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })

  it("keeps a viewer's captions out of reach once a start was accepted", () => {
    shownVideoId = "vid-13"
    probe("vid-13", "op-accepted-2")
    send({ action: "claim", operationIds: ["op-accepted-2"] })
    // The viewer then uses the captions themselves.
    setPressed(false)
    setPressed(true)

    restore("vid-13", "op-accepted-2")
    send({ action: "cancel", operationId: "op-accepted-2" })

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })

  it("records nothing for a claimed fetch that switches captions on after the claim", () => {
    shownVideoId = "vid-14"
    send({ action: "claim", operationIds: ["op-late"] })

    probe("vid-14", "op-late")
    expect(pressed).toBe(true)
    restore("vid-14", "op-late")

    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })

  it("leaves another fetch's record when a claim names different fetches", () => {
    shownVideoId = "vid-15"
    probe("vid-15", "op-kept")

    send({ action: "claim", operationIds: ["op-not-kept"] })
    restore("vid-15", "op-kept")

    expect(pressed).toBe(false)
  })

  it("puts back at cancel what the fetch already changed, while the player shows its video", () => {
    shownVideoId = "vid-16"
    probe("vid-16", "op-abandoned")

    send({ action: "cancel", operationId: "op-abandoned" })

    expect(pressed).toBe(false)
    expect(toggleCaptions).toHaveBeenCalledTimes(2)
    // And whatever it still had queued is refused.
    send({ action: "ensure", expectedVideoId: "vid-16", operationId: "op-abandoned" })
    expect(toggleCaptions).toHaveBeenCalledTimes(2)
  })

  it("does not reach into another video's player at cancel, and spends the record", () => {
    shownVideoId = "vid-17"
    probe("vid-17", "op-moved-on")
    shownVideoId = "vid-18"

    send({ action: "cancel", operationId: "op-moved-on" })
    expect(toggleCaptions).toHaveBeenCalledOnce()

    shownVideoId = "vid-17"
    restore("vid-17", "op-moved-on")
    expect(toggleCaptions).toHaveBeenCalledOnce()
    expect(pressed).toBe(true)
  })

  it("lets a cancel of one fetch leave another fetch's record alone", () => {
    shownVideoId = "vid-19"
    probe("vid-19", "op-current")

    send({ action: "cancel", operationId: "op-earlier" })
    expect(pressed).toBe(true)

    restore("vid-19", "op-current")
    expect(pressed).toBe(false)
  })
})
