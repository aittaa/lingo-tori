#!/usr/bin/env node
/** Read-only locale and local documentation-link audit. No network or provider calls. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
// Use the same YAML parser as the repository's existing Vite YAML plugin.
const { load, loadAll } = createRequire(require.resolve("@modyfi/vite-plugin-yaml"))("js-yaml")
const root = process.cwd()
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--base" || !/^[a-f0-9]{40}$/.test(args[1]))
  throw new Error("Usage: node scripts/audit-ui-resources.mjs --base FULL_COMMIT_SHA")
const base = args[1]
const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8" }).trimEnd()
if (path.resolve(git("rev-parse", "--show-toplevel")) !== path.resolve(root))
  throw new Error("Run from the repository root")

function flatten(value, prefix = "") {
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (item && typeof item === "object" && !Array.isArray(item))
      Object.assign(result, flatten(item, fullKey))
    else result[fullKey] = item
  }
  return result
}

const locales = readdirSync("src/locales")
  .filter((file) => file.endsWith(".yml"))
  .map((file) => file.slice(0, -4))
  .sort()
const localeListFile = path.resolve("src/utils/i18n/locales.ts")
const supportedLocales = existsSync(localeListFile)
  ? [...(await import(pathToFileURL(localeListFile).href)).SUPPORTED_UI_LOCALES].sort((a, b) =>
      a.localeCompare(b),
    )
  : locales
const localeListParity = JSON.stringify(locales) === JSON.stringify(supportedLocales)
const coverage = existsSync("docs/ui-locale-coverage.json")
  ? JSON.parse(readFileSync("docs/ui-locale-coverage.json", "utf8"))
  : undefined
const current = {}
const previous = {}
for (const locale of locales) {
  const file = `src/locales/${locale}.yml`
  current[locale] = flatten(load(readFileSync(file, "utf8")))
  previous[locale] = git("ls-tree", "--name-only", base, "--", file)
    ? flatten(load(git("show", `${base}:${file}`)))
    : {}
}
const reference = { ...coverage?.pendingSharedKeys, ...current.en }

// Context-menu selection titles use Chrome's %s substitution; it must survive translation.
const signature = (value) =>
  JSON.stringify((String(value).match(/%s|\$\d+|\{\{[^}]+\}\}/g) ?? []).sort())
const missing = (resource, comparison) =>
  Object.keys(comparison).filter((key) => !(key in resource))
const fallbackKeys = {}
const newFallbackKeys = {}
const placeholderDifferences = []
const newPlaceholderDifferences = []
const extraKeys = {}
const undocumentedFallbacks = {}
const staleFallbacks = {}
const canonicalPromptDifferences = []
const restoredRemovedKeys = []
for (const locale of locales.filter((language) => language !== "en")) {
  const restored = coverage?.restoredLocales.includes(locale)
  const documented = restored
    ? [
        ...coverage.canonicalModelKeys,
        ...coverage.dictionaryFallbackKeys,
        ...coverage.changedEnglishKeys,
        ...coverage.newEnglishKeys,
        ...coverage.deferredHubKeys,
        ...coverage.missingUpstream[locale],
      ]
    : []
  fallbackKeys[locale] = missing(current[locale], current.en)
  newFallbackKeys[locale] = fallbackKeys[locale].filter(
    (key) => !documented.includes(key) && !missing(previous[locale], previous.en).includes(key),
  )
  extraKeys[locale] = missing(reference, current[locale])
  if (restored) {
    undocumentedFallbacks[locale] = fallbackKeys[locale].filter((key) => !documented.includes(key))
    staleFallbacks[locale] = documented.filter((key) => key in current[locale])
    for (const key of Object.keys(current[locale]))
      if (coverage.deferredHubKeys.includes(key)) restoredRemovedKeys.push(`${locale}:${key}`)
  }
  const modelKeys = [
    ...(coverage?.canonicalModelKeys ?? []),
    ...(restored ? coverage.dictionaryFallbackKeys : []),
  ]
  for (const key of modelKeys)
    if ((current[locale][key] ?? current.en[key]) !== current.en[key])
      canonicalPromptDifferences.push(`${locale}:${key}`)
  for (const key of Object.keys(current[locale])) {
    if (key in reference && signature(current[locale][key]) !== signature(reference[key])) {
      placeholderDifferences.push(`${locale}:${key}`)
      if (restored || signature(previous[locale][key]) === signature(previous.en[key]))
        newPlaceholderDifferences.push(`${locale}:${key}`)
    }
  }
}

const removed = missing(current.en, previous.en)
const added = missing(previous.en, current.en)
const removedKeyReferences = []
const tracked = git("ls-files", "-z").split("\0").filter(Boolean)
for (const file of tracked.filter(
  (sourcePath) =>
    sourcePath.startsWith("src/") &&
    /\.(ts|tsx)$/.test(sourcePath) &&
    !sourcePath.includes("/__tests__/"),
)) {
  if (!existsSync(file)) continue
  const source = readFileSync(file, "utf8")
  for (const key of removed)
    if (source.includes(`"${key}"`) || source.includes(`'${key}'`))
      removedKeyReferences.push(`${file}:${key}`)
}

// Include new documentation even before it is staged.
const docs = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/index.md",
  "docs/byok.md",
  "docs/experimental-byos.md",
  "docs/metrics/README.md",
  "docs/metrics/en-ko-ja-cleanup.md",
  ...["docs/ui-locale-restoration.md"].filter((file) => existsSync(file)),
]
const brokenLocalLinks = []
let localLinks = 0
for (const file of docs) {
  const text = readFileSync(file, "utf8")
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1]
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    localLinks++
    const pathname = decodeURIComponent(target.split("#")[0])
    if (!existsSync(path.resolve(path.dirname(file), pathname)))
      brokenLocalLinks.push(`${file}:${target}`)
  }
}

const deletedAssets = git("diff", base, "--name-only", "--diff-filter=D")
  .split("\n")
  .filter((file) => file.startsWith("assets/") || file.startsWith("src/assets/"))
const deletedAssetBytes = deletedAssets.reduce(
  (bytes, file) => bytes + Number(git("cat-file", "-s", `${base}:${file}`)),
  0,
)
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const lockDocuments = loadAll(readFileSync("pnpm-lock.yaml", "utf8"))
const preservedFiles = {}
for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "wxt.config.ts",
  "LICENSE",
  "public/LICENSE",
  "public/NOTICE.txt",
]) {
  const content = readFileSync(file)
  preservedFiles[file] = {
    unchanged: content.equals(execFileSync("git", ["show", `${base}:${file}`])),
    sha256: createHash("sha256").update(content).digest("hex"),
  }
}

const result = {
  base,
  locales,
  supportedLocales,
  localeListParity,
  keys: Object.fromEntries(locales.map((locale) => [locale, Object.keys(current[locale]).length])),
  removedKeys: removed.length,
  addedKeys: added,
  fallbackKeys,
  newFallbackKeys,
  extraKeys,
  undocumentedFallbacks,
  staleFallbacks,
  canonicalPromptDifferences,
  restoredRemovedKeys,
  placeholderDifferences,
  newPlaceholderDifferences,
  removedKeyReferences,
  localLinks,
  brokenLocalLinks,
  deletedAssetFiles: deletedAssets.length,
  deletedAssetBytes,
  directDependencies: {
    runtime: Object.keys(packageJson.dependencies ?? {}).length,
    development: Object.keys(packageJson.devDependencies ?? {}).length,
  },
  lockfile: {
    documents: lockDocuments.map((document) => ({
      packageEntries: Object.keys(document.packages ?? {}).length,
      resolvedSnapshots: Object.keys(document.snapshots ?? {}).length,
    })),
    uniquePackageEntries: new Set(
      lockDocuments.flatMap((document) => Object.keys(document.packages ?? {})),
    ).size,
    uniqueResolvedSnapshots: new Set(
      lockDocuments.flatMap((document) => Object.keys(document.snapshots ?? {})),
    ).size,
  },
  preservedFiles,
  note: "Literal source references and local file destinations only; dynamic key construction and remote URL status require separate review.",
}
console.log(JSON.stringify(result, null, 2))
if (
  !localeListParity ||
  Object.values(newFallbackKeys).some((keys) => keys.length) ||
  Object.values(extraKeys).some((keys) => keys.length) ||
  Object.values(undocumentedFallbacks).some((keys) => keys.length) ||
  Object.values(staleFallbacks).some((keys) => keys.length) ||
  canonicalPromptDifferences.length ||
  restoredRemovedKeys.length ||
  newPlaceholderDifferences.length ||
  removedKeyReferences.length ||
  brokenLocalLinks.length
)
  process.exitCode = 1
