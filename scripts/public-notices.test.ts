import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PRIVACY_NOTICE_URL, THIRD_PARTY_NOTICES_PATH } from "../src/utils/constants/notices"

const root = path.resolve(".")
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8")

const thirdParty = read("public/THIRD_PARTY_NOTICES.txt")
const privacy = read("docs/privacy.md")
const readme = read("README.md")

// Text a user or a store reviewer can read. Execution evidence stays out of all of it.
const publicFiles = [
  "README.md",
  "docs/privacy.md",
  "public/NOTICE.txt",
  "public/THIRD_PARTY_NOTICES.txt",
  ...readdirSync(path.join(root, "public/licenses")).map((name) => `public/licenses/${name}`),
  ...readdirSync(path.join(root, ".changeset"))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => `.changeset/${name}`),
]

describe("public text carries no local paths or internal identifiers", () => {
  it.each(publicFiles)("%s", (file) => {
    const text = read(file)

    expect(text).not.toMatch(/\/Users\/|\/private\/tmp\/|\/tmp\/|\/var\/folders\//)
    expect(text).not.toMatch(/\b(?:term|task|msg|ctx|run|wf)_[0-9a-f]{8,}/)
  })
})

describe("the Inter font notice", () => {
  const installed = createRequire(import.meta.url).resolve(
    "@fontsource-variable/inter/package.json",
  )
  const license = read("public/licenses/Inter-OFL-1.1.txt")

  it("is the license text that ships with the installed font package, byte for byte", () => {
    expect(license).toBe(readFileSync(path.join(path.dirname(installed), "LICENSE"), "utf8"))
  })

  it("is the SIL Open Font License 1.1 with the Inter copyright line", () => {
    expect(license).toContain("Copyright 2016 The Inter Project Authors")
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1")
  })

  it("is named by the third-party notices and by NOTICE.txt", () => {
    expect(thirdParty).toContain("licenses/Inter-OFL-1.1.txt")
    expect(read("public/NOTICE.txt")).toContain("licenses/Inter-OFL-1.1.txt")
    expect(read("public/NOTICE.txt")).toContain("THIRD_PARTY_NOTICES.txt")
  })
})

describe("the third-party notices", () => {
  const lines = thirdParty.split("\n")
  const indexStart = lines.indexOf("2. Bundled packages")
  const textsStart = lines.indexOf("3. License texts and notices")
  const entries = lines
    .slice(indexStart, textsStart)
    .map((line) => /^ {2}(\S+) (\S+)\s+(\S+)\s+(T\d{3})$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, name, version, license, text]) => ({
      name: name!,
      version: version!,
      license: license!,
      text: text!,
    }))
  const textIds = new Set(
    lines.map((line) => /^(T\d{3}) {2}/.exec(line)?.[1]).filter((id): id is string => !!id),
  )

  it("lists packages, and says how many", () => {
    expect(entries.length).toBeGreaterThan(100)
    expect(thirdParty).toContain(`${entries.length} package versions.`)
  })

  it("points every package at a license text that exists", () => {
    const dangling = entries
      .filter(({ text }) => !textIds.has(text))
      .map(({ name, version, text }) => `${name} ${version} -> ${text}`)

    expect(dangling).toEqual([])
  })

  it("names only package versions the lockfile pins", () => {
    const lockfile = read("pnpm-lock.yaml")
    const pinned = new Set(
      [...lockfile.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@(\d[^\s':(]*)/gm)].map(
        (match) => `${match[1]}@${match[2]}`,
      ),
    )

    const unpinned = entries
      .filter(({ name, version }) => !pinned.has(`${name}@${version}`))
      .map(({ name, version }) => `${name}@${version}`)

    expect(unpinned).toEqual([])
  })

  it("reproduces the Apache License text for the packages that state it only in short form", () => {
    expect(thirdParty).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")
    expect(thirdParty).toContain("END OF TERMS AND CONDITIONS")
  })

  it("does not claim a package that the build does not bundle", () => {
    // The icon package is a dependency, but nothing imports it; the bundle analysis shows no module.
    expect(thirdParty).not.toContain("@remixicon/react")
  })
})

describe("the options page links", () => {
  it("point at files that exist", () => {
    expect(PRIVACY_NOTICE_URL).toBe(
      "https://github.com/aittaa/lingo-tori/blob/main/docs/privacy.md",
    )
    expect(existsSync(path.join(root, "docs/privacy.md"))).toBe(true)
    // `public/` is copied to the root of both builds.
    expect(existsSync(path.join(root, "public", THIRD_PARTY_NOTICES_PATH))).toBe(true)
  })
})

function slug(heading: string) {
  return heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N} _-]/gu, "")
    .replaceAll(" ", "-")
}

describe("the readme links", () => {
  const headings = (text: string) =>
    new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]!)))

  it("resolve to files and headings that exist", () => {
    const links = [...readme.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)].map((match) => match[1]!)

    const broken = links.filter((link) => {
      const [file, anchor] = link.split("#")
      if (!existsSync(path.join(root, file!))) return true
      return anchor !== undefined && !headings(read(file!)).has(anchor)
    })

    expect(links.length).toBeGreaterThan(10)
    expect(broken).toEqual([])
  })

  it("link the privacy notice and the third-party notices", () => {
    expect(readme).toContain("(docs/privacy.md)")
    expect(readme).toContain("(public/THIRD_PARTY_NOTICES.txt)")
    expect(readme).toContain("(public/licenses/Inter-OFL-1.1.txt)")
  })
})

describe("the privacy notice", () => {
  const headings = [...privacy.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]!)

  it("names the operator and the contact", () => {
    expect(privacy).toContain("김현")
    expect(privacy).toContain("hyeonkim.develop@gmail.com")
  })

  it("leaves undecided facts undecided", () => {
    expect(privacy).toMatch(/jurisdiction[^\n]*\n[^\n]*revenue model/i)
    expect(privacy).toContain("**not yet decided**")
    expect(privacy).not.toMatch(/https:\/\/(?:chromewebstore|addons\.mozilla|chrome\.google)/)
    expect(privacy).not.toMatch(/effective (?:date|as of)[: ]+\d{4}/i)
  })

  it("makes no legal or store readiness claim", () => {
    expect(privacy).toContain("not a legal privacy policy")
    expect(privacy).not.toMatch(/\b(?:legally|store)[- ]ready\b|\bcompliant with\b/i)
  })

  it.each([
    "Text sent to your AI provider",
    "Smart context (off by default)",
    "The page address in custom actions and note suggestions",
    "Translated pages may contain private content",
    "Signing in with ChatGPT (experimental)",
    "Public asset hosts and links",
    "Settings, keys and glossary",
    "Backups",
    "Preserved originals and recovery copies",
    "Translation cache and private windows",
    "Usage statistics (local only)",
    "Exporting your settings",
    "Firefox data consent",
    "Endpoints you enter, including HTTP and local networks",
  ])("covers: %s", (heading) => {
    expect(headings).toContain(heading)
  })

  it("states the Firefox categories, the in-flight limit and what was not verified", () => {
    expect(privacy).toContain("Website content, required")
    expect(privacy).toContain("Authentication info, optional")
    expect(privacy).toContain("Browsing activity, optional")
    expect(privacy).toContain("already been sent may finish")
    expect(privacy).toContain("have not been verified")
  })

  it("says the permission is read right before each send, retries included, and claims no more", () => {
    expect(privacy).toContain("right before each request is sent")
    expect(privacy).toContain("every retry the AI SDK makes")
    expect(privacy).toContain("every ChatGPT request")
    expect(privacy).not.toMatch(/before every (?:new )?request/i)
    expect(privacy).not.toMatch(/every request or retry/i)
  })

  it("says a request for the browser's cookies needs authentication info", () => {
    expect(privacy).toContain("`credentials: include`")
  })

  it("says placeholders are filled in one pass and look-alike page text is not replaced", () => {
    expect(privacy).toContain("filled in one pass")
    expect(privacy).toContain("is sent as those characters and is not replaced by the address")
    expect(privacy).toContain("Page text that only looks like the placeholder does not count")
  })

  it("says permissions are granted only with the Allow buttons, with no automatic prompt", () => {
    expect(privacy).toContain("**Allow** buttons")
    expect(privacy).toContain("does not open a Firefox permission prompt by itself")
    expect(readme).toContain("Allow buttons in Settings")
    expect(readme).toContain("never opens a permission prompt by itself")
  })

  it("says a cancelled, replaced or expired sign-in does not open its page", () => {
    expect(privacy).toMatch(/cancelled, replaced or expires[^.]*does not open the sign-in page/)
    expect(privacy).toContain("Cancelling a sign-in")
  })

  it("separates the local sign-out from a remote revocation that is not confirmed", () => {
    expect(privacy).toContain("Signing out always clears the local tokens")
    expect(privacy).toContain("the remote revocation is skipped and reported as unconfirmed")
  })

  it("keeps the temporary-install and signed-dialog limits", () => {
    expect(privacy).toContain("temporary add-on installation")
    expect(privacy).toContain("when you install a signed add-on")
  })

  it("keeps the export note aligned with what the redactor does", () => {
    expect(privacy).toContain("the whole `headers` object")
    expect(privacy).toContain("if the cleaning cannot finish no file is written")
    expect(privacy).toContain("It cannot recognise a secret placed in an ordinary-looking part")
  })

  it("does not present Smart context OFF as keeping page context from the provider", () => {
    expect(privacy).toContain(
      "Smart context controls one thing: the optional generated page summary",
    )
    expect(privacy).toContain(
      "Turning it off does not stop other page context from reaching your provider",
    )
    expect(privacy).toContain("whether or not Smart context is on")
    expect(privacy).toContain(
      "A custom action likewise fills `{{webTitle}}` and `{{webContent}}` from the page",
    )
    expect(privacy).toContain("`{{webTitle}}`, `{{webDescription}}`, `{{webContent}}`")
    expect(privacy).not.toContain("Leave it off if you do not want that to reach your provider")
    expect(privacy).not.toContain("Pages you do not translate are not sent")
    expect(privacy).toContain("a feature you turned on acts on it")
  })

  it("says cancelling does not always stop the browser's request", () => {
    expect(privacy).toContain("when no other operation still needs it")
    expect(privacy).toContain("then it continues for them")
    expect(privacy).toContain("does not always stop the browser's request")
    expect(privacy).not.toContain("stops the browser's request. It does not guarantee")
  })

  it("states cleanup as best-effort thresholds, not strict retention bounds", () => {
    expect(privacy).toContain("Seven days is the cleanup threshold")
    expect(privacy).toContain("about once a day while the browser and the extension are running")
    expect(privacy).toContain("so an entry can stay longer than seven days")
    expect(privacy).toContain("those are thresholds for that cleanup")
    expect(privacy).not.toContain("for **seven days** and then deletes them")
    expect(privacy).not.toContain("It keeps at most 10,000 entries for 120 days")
  })

  it("does not infer the user's operating-system protection", () => {
    expect(privacy).not.toMatch(/not protected by the operating system/i)
    expect(privacy).not.toContain("the browser does not encrypt them for you")
    expect(privacy).not.toContain("stored as plain text")
    expect(privacy).toContain("does not add encryption to API keys")
    expect(privacy).toContain("does not promise operating-system-backed protection")
    expect(privacy).toContain("without encryption added by LingoTori")
    expect(readme).toContain("without encryption added by LingoTori")
    expect(readme).not.toContain("as plain text")
  })

  it("says where the asset requests happen and that the privacy link goes to GitHub", () => {
    expect(privacy).toContain(
      "the add-provider list in the settings, which shows a logo for every provider you can choose",
    )
    expect(privacy).toContain("the popup and in the toolbar on a page")
    expect(privacy).toContain("identify the icon that is displayed")
    expect(privacy).toContain("opening it makes an ordinary request to `github.com`")
    expect(privacy).toContain("opens a file inside the extension and makes no request")
  })

  it("keeps the footer comment honest about the GitHub request", () => {
    const footer = read("src/entrypoints/options/app-sidebar/about-links.tsx")

    expect(footer).toContain("makes an ordinary request to github.com")
    expect(footer).not.toContain("neither sends anything")
  })

  it("links only to headings that exist in the notice", () => {
    const anchors = [...privacy.matchAll(/\]\(#([^)\s]+)\)/g)].map((match) => match[1]!)
    const known = new Set([...privacy.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]!)))

    expect(anchors.length).toBeGreaterThan(2)
    expect(anchors.filter((anchor) => !known.has(anchor))).toEqual([])
  })

  it("states the sign-out limit when Firefox consent is absent", () => {
    expect(privacy).toMatch(/revocation request at all/)
    expect(privacy).toContain("unconfirmed")
  })

  it("says preserved originals can contain secrets and are removed only by the user", () => {
    expect(privacy).toContain("It can contain API keys and other secrets")
    expect(privacy).toContain("never deletes one by itself")
  })

  it("names the public hosts that see the IP address and the slug", () => {
    expect(privacy).toContain("unpkg.com")
    expect(privacy).toContain("api.iconify.design")
  })
})

/** The text of one `##` or `###` section, up to the next heading of those levels. */
function sectionOf(text: string, heading: string) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => /^#{2,3} /.test(line) && line.endsWith(` ${heading}`))
  if (start === -1) return ""
  const length = lines.slice(start + 1).findIndex((line) => /^#{2,3} /.test(line))
  return lines.slice(start + 1, length === -1 ? undefined : start + 1 + length).join("\n")
}

describe("the Firefox note about a secret in an endpoint", () => {
  const firefox = sectionOf(privacy, "Firefox data consent")

  it("says the declaration makes authentication consent required and opens no prompt itself", () => {
    expect(firefox).toContain("makes authentication consent required for that provider")
    expect(firefox).toContain("does not open a Firefox prompt by itself")
  })

  it("tells the user to click the separate Allow button, and that requests wait until then", () => {
    expect(firefox).toContain("click the separate **Allow** button")
    expect(firefox).toContain("until you do, requests to that endpoint are not sent")
  })

  it("says what LingoTori cannot detect or gate", () => {
    expect(firefox).toContain("cannot detect or gate an undeclared secret")
  })

  it("does not promise that Firefox asks first", () => {
    expect(firefox).not.toMatch(/Firefox asks first/i)
    expect(firefox).not.toContain("so that Firefox asks")
  })
})

describe("the notice about settings that cannot be read", () => {
  const recovery = sectionOf(privacy, "Preserved originals and recovery copies")

  it("is a section that exists and carries no unverified marker any more", () => {
    expect(recovery).not.toBe("")
    expect(privacy).not.toMatch(/<!--[\s\S]*?TODO[\s\S]*?-->/)
  })

  it("says a copy is tried at start-up and is not always possible", () => {
    expect(recovery).toContain("tries to keep an **exact copy of the stored original**")
    expect(recovery).toContain("best effort")
    expect(recovery).toContain("With five copies already kept")
    expect(recovery).toContain("no copy is made")
    expect(recovery).toContain("the stored settings are still left exactly as they are")
  })

  it("does not say a copy is always kept first", () => {
    expect(recovery).not.toContain("It first keeps an **exact copy")
    expect(recovery).not.toContain("only after the original has been verified as preserved")
    expect(readme).not.toContain("it keeps an exact copy of the original")
  })

  it("says starting from defaults and restoring over unreadable settings wait for a kept copy", () => {
    expect(recovery).toContain("keep an exact copy of them first")
    expect(recovery).toContain("refused, with the stored settings left exactly as they are")
    expect(recovery).toContain("until a copy can be kept")
  })

  it("says restoring over readable settings backs them up first, unless the latest backup has them", () => {
    expect(recovery).toContain("restoring backs them up first")
    expect(recovery).toContain("unless the latest backup already holds the same settings")
  })

  it("says what happens to that backup when the replacement fails or is not confirmed", () => {
    expect(recovery).toContain(
      "If the replacement then fails and the settings are still exactly as they were, that backup is taken back",
    )
    expect(recovery).toContain(
      "if it cannot be confirmed whether the replacement happened, the backup stays",
    )
  })

  it("uses the labels of the screen and says both exports hold credentials", () => {
    expect(recovery).toContain("**Export exact copy**")
    expect(recovery).toContain("**Export as found**")
    expect(recovery).toContain("**Recovery options**")
    expect(recovery).toContain("**Start from defaults**")
    expect(recovery).toContain("**Try restore**")
    expect(recovery).toContain("API keys and other credentials exactly as stored")
    expect(recovery).toContain("warns before each download")
    expect(privacy).not.toContain("Export exact JSON")
  })

  it("says what happens to changes while the settings cannot be read", () => {
    expect(recovery).toContain("A change made in the settings page or the popup is not saved")
    expect(recovery).toContain("Your saved settings can't be read")
    expect(recovery).toContain("Your last change was not saved")
    expect(recovery).toContain("show no banner")
    expect(recovery).toContain("shows a short notice")
  })

  it("says the hourly backup skips them and Back up now is refused", () => {
    expect(recovery).toContain("The hourly backup skips settings that cannot be read")
    expect(recovery).toContain("**Back up now** is refused while they cannot be read")
  })

  it("keeps the limits and adds the failed-upgrade case", () => {
    expect(recovery).toContain("may still need your recovery")
    expect(recovery).toContain("does not claim that the browser's storage is crash-proof")
    expect(recovery).toContain("relies on the extension having one background context")
    expect(recovery).toContain("If a failed upgrade cannot even be recorded")
    expect(recovery).toContain("as being upgraded")
  })

  describe("when a failed upgrade cannot even be recorded", () => {
    const marker = "If a failed upgrade cannot even be recorded"
    const state = recovery.slice(recovery.indexOf(marker))

    it("keeps the cross-context uncertainty", () => {
      expect(state).toContain(
        "another open settings page can still treat the settings as being upgraded",
      )
    })

    it("refuses ordinary changes and exporting the current settings", () => {
      expect(state).toContain("ordinary changes and exporting the current settings are refused")
    })

    it("refuses backups, hourly and Back up now", () => {
      expect(state).toContain("the hourly backup skips them and **Back up now** is refused")
    })

    it("keeps Export as found available, which the current export is not", () => {
      expect(state).toContain("**Export as found** stays available")
      // The refusal is about the current settings, never about the recovery export.
      expect(state).not.toMatch(/Export as found\*\* (?:is|are) refused/)
      expect(state).not.toContain("exporting them")
    })

    it("lets an explicit recovery action replace the settings once an exact copy is confirmed", () => {
      expect(state).toContain(
        "Restoring a kept copy or starting from defaults still replaces the settings, but only after an exact copy of them has been kept and confirmed",
      )
    })

    it("does not carry the old broad refusal or the unconditional nothing-is-replaced", () => {
      expect(state).not.toContain("changing, replacing, backing up or exporting them is refused")
      expect(state).not.toContain("so nothing is replaced")
      expect(state).not.toMatch(
        /(?:replacing|restoring|starting from defaults)[^.]*is refused in that state/,
      )
    })
  })

  it("keeps secrets, the five-copy limit and the user-only removal", () => {
    expect(recovery).toContain("at most five preserved originals")
    expect(recovery).toContain("It never deletes one by itself")
    expect(recovery).toContain("when you uninstall the extension")
  })

  it("is summarised in the readme without claiming a copy is always kept", () => {
    expect(readme).toContain("tries to keep an exact copy")
    expect(readme).toContain("not always possible")
    expect(readme).toContain("**Export as found**")
  })
})

describe("the notice about backups", () => {
  const backups = sectionOf(privacy, "Backups")

  it("says the newest eight are normally kept, and that a backup can briefly add to them", () => {
    expect(backups).toContain("normally keeps the newest eight")
    expect(backups).toContain(
      "a backup taken just before a restore that could not be confirmed is kept, so there can briefly be more until the next backup",
    )
  })

  it("does not promise exactly eight", () => {
    expect(backups).not.toMatch(/\band keeps the newest eight\b/)
    expect(backups).not.toMatch(/\bnever (?:more|keeps more) than eight\b/i)
  })

  it("does not list internal request hashes as backup contents", () => {
    expect(backups).not.toMatch(/opDigest|request hash|operation (?:id|digest)/i)
  })
})

describe("the sign-in that waits for the Firefox permission", () => {
  it("also does not open the page when its session is invalidated", () => {
    const text = sectionOf(privacy, "Firefox data consent")

    expect(text).toMatch(
      /cancelled, replaced or expires, or whose session is invalidated \(for example by a token refresh that fails for good\), while the permission is being read does not open the sign-in page/,
    )
    expect(sectionOf(privacy, "Signing in with ChatGPT (experimental)")).toContain(
      "or its session is invalidated (for example by a token refresh that fails for good)",
    )
  })
})

describe("the readme upgrade paragraph", () => {
  it("still points to the version notes and claims no check of the version reset", () => {
    const paragraph = readme
      .split("\n")
      .find((line) => line.includes("Already using a development copy"))

    expect(paragraph).toContain("[installation and version notes](docs/versioning.md)")
    expect(paragraph).not.toMatch(/validated|verified|tested|confirmed/i)
  })
})
