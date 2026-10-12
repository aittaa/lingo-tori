import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const auditScript = path.resolve("scripts/audit-ui-resources.mjs")
const fixtureEnv = {
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  SKIP_FREE_API: "true",
}
let fixtureRoot: string
let fixtureBase: string

function writeFixtureFile(relative: string, content: string) {
  const filename = path.join(fixtureRoot, relative)
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, content)
}

function fixtureGit(...gitArgs: string[]) {
  return execFileSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      ...gitArgs,
    ],
    { cwd: fixtureRoot, env: fixtureEnv, encoding: "utf8" },
  ).trim()
}

function runAudit() {
  const result = spawnSync(process.execPath, [auditScript, "--base", fixtureBase], {
    cwd: fixtureRoot,
    env: fixtureEnv,
    encoding: "utf8",
  })
  expect(result.error).toBeUndefined()
  return { status: result.status, report: JSON.parse(result.stdout) }
}

function replaceFixtureToken(locale: string, token: string) {
  const filename = path.join(fixtureRoot, `src/locales/${locale}.yml`)
  writeFileSync(filename, readFileSync(filename, "utf8").replace(token, ""))
}

const sharedKeys = {
  "languageSearch.placeholder": "Search languages...",
  "languageSearch.noResults": "No languages found",
  "translation.failed": "Translation Failed",
  "translation.failedFallback": "Translation failed",
}
const restoredFixture = {
  "contextMenu.translateSelection": 'Traducir "%s"',
  "fixture.positional": "$1",
  "fixture.named": "{{term}}",
  "languageSearch.placeholder": "Buscar idiomas...",
  "languageSearch.noResults": "No se encontraron idiomas",
  "translation.failed": "Traducción fallida",
  "translation.failedFallback": "Error de traducción",
}

function writeRestoredCoverage(
  resource: Record<string, string>,
  changedEnglishKeys: string[] = [],
) {
  // This synthetic upstream commit deliberately does not exist in the fixture repository.
  const upstreamCommit = "a".repeat(40)
  const restoredResourceSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        upstreamCommit,
        locale: "es",
        entries: Object.keys(resource)
          .sort()
          .map((key) => [key, resource[key]]),
      }),
    )
    .digest("hex")
  const coverage = {
    upstreamCommit,
    restoredResourceSha256: { es: restoredResourceSha256 },
    restoredLocales: ["es"],
    canonicalModelKeys: [],
    dictionaryFallbackKeys: [],
    changedEnglishKeys,
    newEnglishKeys: [],
    deferredHubKeys: [],
    pendingSharedKeys: sharedKeys,
    missingUpstream: { es: [] },
  }
  writeFixtureFile("docs/ui-locale-coverage.json", JSON.stringify(coverage))
  return coverage
}

describe("UI resource audit placeholder regression", () => {
  beforeEach(() => {
    fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "lingotori-ui-audit-")))
    const titles = { en: 'Translate "%s"', ko: '"%s" 번역', ja: "「%s」を翻訳" }
    for (const [locale, title] of Object.entries(titles))
      writeFixtureFile(
        `src/locales/${locale}.yml`,
        JSON.stringify({
          contextMenu: { translateSelection: title },
          fixture: { positional: "$1", named: "{{term}}" },
        }),
      )
    for (const filename of [
      "README.md",
      "CONTRIBUTING.md",
      "docs/index.md",
      "docs/byok.md",
      "docs/experimental-byos.md",
      "docs/metrics/README.md",
      "docs/metrics/en-ko-ja-cleanup.md",
      "LICENSE",
      "public/LICENSE",
      "public/NOTICE.txt",
    ])
      writeFixtureFile(filename, "Synthetic fixture\n")
    writeFixtureFile("package.json", '{"name":"fixture"}\n')
    writeFixtureFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    writeFixtureFile("wxt.config.ts", "// Synthetic fixture\n")
    fixtureGit("init", "--template=", "--initial-branch=fixture")
    fixtureGit("add", ".")
    fixtureGit(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    )
    fixtureBase = fixtureGit("rev-parse", "HEAD")
  })

  afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  it("accepts EN/KO/JA with matching Chrome and existing placeholders", () => {
    const result = runAudit()
    expect(result.status).toBe(0)
    expect(result.report.placeholderDifferences).toEqual([])
    expect(result.report.newPlaceholderDifferences).toEqual([])
  })

  it.each(["ko", "ja"])("rejects a missing Chrome %%s token in %s", (locale) => {
    replaceFixtureToken(locale, "%s")
    const result = runAudit()
    expect(result.status).toBe(1)
    expect(result.report.placeholderDifferences).toEqual([
      `${locale}:contextMenu.translateSelection`,
    ])
    expect(result.report.newPlaceholderDifferences).toEqual([
      `${locale}:contextMenu.translateSelection`,
    ])
  })

  it.each([
    ["$1", "positional"],
    ["{{term}}", "named"],
  ])("retains detection of a missing %s token", (token, key) => {
    replaceFixtureToken("ko", token)
    const result = runAudit()
    expect(result.status).toBe(1)
    expect(result.report.newPlaceholderDifferences).toEqual([`ko:fixture.${key}`])
  })

  it("discovers a restored locale absent from the base without missing its placeholders", () => {
    writeFixtureFile(
      "src/locales/es.yml",
      readFileSync(path.join(fixtureRoot, "src/locales/en.yml"), "utf8"),
    )
    replaceFixtureToken("es", "%s")
    const result = runAudit()
    expect(result.report.locales).toEqual(["en", "es", "ja", "ko"])
    expect(result.status).toBe(1)
    expect(result.report.newPlaceholderDifferences).toEqual(["es:contextMenu.translateSelection"])
  })

  it("accepts documented restored fallbacks and rejects an unrecorded missing key", () => {
    const resource = { ...restoredFixture }
    delete (resource as Record<string, string>)["fixture.named"]
    writeFixtureFile("src/locales/es.yml", JSON.stringify(resource))
    writeRestoredCoverage(resource, ["fixture.named"])
    const accepted = runAudit()
    expect(accepted.status).toBe(0)
    expect(accepted.report.fallbackKeys.es).toEqual(["fixture.named"])
    delete (resource as Record<string, string>)["fixture.positional"]
    writeFixtureFile("src/locales/es.yml", JSON.stringify(resource))
    const rejected = runAudit()
    expect(rejected.status).toBe(1)
    expect(rejected.report.undocumentedFallbacks.es).toEqual(["fixture.positional"])
  })

  describe("restored source integrity", () => {
    beforeEach(() => {
      writeFixtureFile("src/locales/es.yml", JSON.stringify(restoredFixture))
      writeRestoredCoverage(restoredFixture)
    })

    it("accepts the pinned snapshot without an upstream Git object or network", () => {
      const result = runAudit()
      expect(result.status).toBe(0)
    })

    it("ignores serialization and key order changes", () => {
      writeFixtureFile(
        "src/locales/es.yml",
        JSON.stringify(Object.fromEntries(Object.entries(restoredFixture).reverse()), null, 2),
      )
      expect(runAudit().status).toBe(0)
    })

    it("rejects a changed value with the same placeholder signature", () => {
      writeFixtureFile(
        "src/locales/es.yml",
        JSON.stringify({
          ...restoredFixture,
          "contextMenu.translateSelection": 'Otra frase "%s"',
        }),
      )
      const result = runAudit()
      expect(result.status).toBe(1)
      expect(result.report.placeholderDifferences).toEqual([])
      expect(result.report.restoredResourceDifferences).toEqual(["es"])
    })

    it.each(Object.keys(sharedKeys))("requires %s even before English adds it", (key) => {
      const resource: Record<string, string> = { ...restoredFixture }
      delete resource[key]
      writeFixtureFile("src/locales/es.yml", JSON.stringify(resource))
      // Even refreshing the digest must not hide a missing required shared key.
      writeRestoredCoverage(resource)
      const result = runAudit()
      expect(result.status).toBe(1)
      expect(result.report.restoredResourceDifferences).toEqual([])
      expect(result.report.missingSharedKeys).toEqual([`es:${key}`])
    })

    it("binds the source commit to the snapshot digest", () => {
      const coverage = writeRestoredCoverage(restoredFixture)
      coverage.upstreamCommit = "b".repeat(40)
      writeFixtureFile("docs/ui-locale-coverage.json", JSON.stringify(coverage))
      const result = runAudit()
      expect(result.status).toBe(1)
      expect(result.report.restoredResourceDifferences).toEqual(["es"])
    })

    it("rejects a missing snapshot digest", () => {
      const coverage = writeRestoredCoverage(restoredFixture)
      writeFixtureFile(
        "docs/ui-locale-coverage.json",
        JSON.stringify({
          ...coverage,
          restoredResourceSha256: {},
        }),
      )
      const result = runAudit()
      expect(result.status).toBe(1)
      expect(result.report.restoredResourceDifferences).toEqual(["es"])
    })
  })
})
