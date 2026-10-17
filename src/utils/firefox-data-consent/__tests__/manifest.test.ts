// What the Firefox and Chrome manifests declare about data, and that the consent work adds no
// browser API permission. The manifest is built from `manifest({ browser })` in wxt.config.ts, the
// same function WXT calls for each target, so this needs no build.
//
// The categories are Mozilla's built-in data consent categories (Firefox 140+).
// - `websiteContent` is required: every core feature sends page, selected or subtitle text to the
//   provider the user chose.
// - `authenticationInfo` is optional: API keys, credential headers and the experimental ChatGPT
//   sign-in send credentials to the user's provider, and only configurations that use them do.
// - `browsingActivity` is optional: a custom action whose prompt, system prompt or output-field
//   description uses `{{webUrl}}` (and the note suggestion built from it) sends the full page URL.
//
// These assertions pin the DECLARATION: which categories the manifest lists. They do not establish
// what the extension does or does not transmit. Other content can pass through a provider request
// (selected webmail text is personal communications, for example, and the settings pages load logos
// and icons from public hosts); the public privacy notice describes those flows, and the approved
// declaration does not list a category for each of them.

import { describe, expect, it } from "vitest"
import config from "../../../../wxt.config"

type Manifest = Record<string, any>

function manifestFor(browser: "firefox" | "chrome"): Manifest {
  const factory = config.manifest as (env: {
    browser: string
    manifestVersion: 3
    mode: string
    command: string
  }) => Manifest
  return factory({ browser, manifestVersion: 3, mode: "production", command: "build" })
}

const firefox = manifestFor("firefox")
const chrome = manifestFor("chrome")
const dataCollection = firefox.browser_specific_settings?.gecko?.data_collection_permissions

describe("Firefox data collection declaration", () => {
  it("requires websiteContent, which every core feature sends to the user's provider", () => {
    expect(dataCollection?.required).toEqual(["websiteContent"])
  })

  it("does not use the `none` declaration, which would contradict the categories it declares", () => {
    expect(dataCollection?.required).not.toContain("none")
    expect(dataCollection?.optional ?? []).not.toContain("none")
  })

  it("offers authenticationInfo and browsingActivity as the only optional categories", () => {
    expect(dataCollection?.optional).toEqual(["authenticationInfo", "browsingActivity"])
  })

  it.each([
    "searchTerms",
    "personalCommunications",
    "personallyIdentifyingInfo",
    "healthInfo",
    "financialAndPaymentInfo",
    "locationInfo",
    "websiteActivity",
    "bookmarksInfo",
    "technicalAndInteraction",
  ])("is not among the declared categories: %s", (undeclared) => {
    const declared = [...(dataCollection?.required ?? []), ...(dataCollection?.optional ?? [])]

    expect(declared).not.toContain(undeclared)
  })

  it("keeps the Firefox 140 floor that built-in consent needs", () => {
    expect(firefox.browser_specific_settings?.gecko?.strict_min_version).toBe("140.0")
    expect(firefox.browser_specific_settings?.gecko?.id).toBe("lingotori@aittaa")
  })
})

describe("Chrome manifest", () => {
  it("has no Firefox-specific settings, and so declares no data collection categories", () => {
    expect(chrome.browser_specific_settings).toBeUndefined()
  })
})

describe("browser API permissions", () => {
  it("lists the Firefox permissions exactly as before the consent work", () => {
    expect(firefox.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "tabs",
      "alarms",
      "contextMenus",
      "scripting",
      "webNavigation",
      "declarativeNetRequestWithHostAccess",
    ])
    expect(firefox.optional_permissions).toBeUndefined()
    expect(firefox.host_permissions).toEqual(["*://*/*"])
  })

  it("lists the Chrome permissions exactly as before the consent work", () => {
    expect(chrome.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "tabs",
      "alarms",
      "contextMenus",
      "scripting",
      "webNavigation",
      "sidePanel",
    ])
    expect(chrome.optional_permissions).toEqual(["declarativeNetRequestWithHostAccess"])
    expect(chrome.host_permissions).toEqual(["*://*/*"])
  })
})
