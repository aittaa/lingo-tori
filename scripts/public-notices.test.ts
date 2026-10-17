import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PRIVACY_NOTICE_URL, THIRD_PARTY_NOTICES_PATH } from "../src/utils/constants/notices"

const root = path.resolve(".")
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8")

const thirdParty = read("public/THIRD_PARTY_NOTICES.txt")
const privacy = read("docs/privacy.md")

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
    .map(([, name, version, license, text]) => ({ name, version, license, text }))
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
  const readme = read("README.md")
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
    "Public asset hosts",
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
    expect(privacy).toContain("already started may finish")
    expect(privacy).toContain("have not been verified")
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
