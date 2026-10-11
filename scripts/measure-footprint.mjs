#!/usr/bin/env node
/** Read-only footprint inventory. No builds, installs, network, or package inspection. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip, constants as zlibConstants } from "node:zlib"

const HELP = `Usage: node scripts/measure-footprint.mjs --repo ABSOLUTE_PATH --output ABSOLUTE_PATH [--output ABSOLUTE_PATH ...] [--baseline ABSOLUTE_JSON_PATH]
Explicit trusted paths only. Prints JSON to stdout; does not write files.
Counts tracked src files using Git; hashes only package.json and pnpm-lock.yaml.
Output directories are inventoried without following symlinks. Gzip is the sum
of independently compressed files at level 9, not an extension archive size.`

function parseArguments(args) {
  const options = { outputs: [] }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === "--help") return { help: true }
    if (!["--repo", "--output", "--baseline"].includes(flag))
      throw new Error(`Unknown option: ${flag}`)
    const value = args[++i]
    if (!value || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path`)
    if (flag === "--output") options.outputs.push(path.resolve(value))
    else {
      const key = flag.slice(2)
      if (options[key]) throw new Error(`Duplicate option: ${flag}`)
      options[key] = path.resolve(value)
    }
  }
  if (!options.repo || options.outputs.length === 0)
    throw new Error("Both --repo and --output are required")
  if (new Set(options.outputs).size !== options.outputs.length)
    throw new Error("Duplicate output path")
  return options
}

// Check every path component, including explicitly supplied roots. lstat alone
// on the leaf would otherwise follow a symlink in a parent directory.
async function assertPlainPath(value, expected) {
  let current = path.parse(value).root
  for (const component of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`Symlink path component rejected: ${current}`)
  }
  const stat = await lstat(value)
  if (expected === "directory" ? !stat.isDirectory() : !stat.isFile())
    throw new Error(`Expected ${expected}: ${value}`)
}

function git(repo, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd()
}

function increment(table, key, value = 1) {
  table[key] = (table[key] ?? 0) + value
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

async function hashFile(filename) {
  await assertPlainPath(filename, "file")
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex")
}

async function gzipBytes(filename) {
  let count = 0
  await pipeline(
    createReadStream(filename),
    createGzip({ level: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY }),
    new Writable({
      write(chunk, _encoding, next) {
        count += chunk.length
        next()
      },
    }),
  )
  return count
}

async function inventoryOutput(root) {
  await assertPlainPath(root, "directory")
  const files = []
  const skippedSymlinks = []
  const skippedSpecialFiles = []
  const skippedSensitivePaths = []
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const filename = path.join(directory, name)
      const stat = await lstat(filename)
      const relative = path.relative(root, filename).split(path.sep).join("/")
      if (
        /^(?:node_modules|\.git|\.aws|\.ssh|\.npmrc|\.netrc|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(
          name,
        ) ||
        /\.(?:pem|key|p12|pfx)$/i.test(name)
      )
        skippedSensitivePaths.push(relative)
      else if (stat.isSymbolicLink()) skippedSymlinks.push(relative)
      else if (stat.isDirectory()) await visit(filename)
      else if (stat.isFile())
        files.push({ path: relative, bytes: stat.size, gzipBytes: await gzipBytes(filename) })
      else skippedSpecialFiles.push(relative)
    }
  }
  await visit(root)
  const byExtension = {}
  for (const file of files) {
    const extension = path.extname(file.path) || "(none)"
    byExtension[extension] ??= { files: 0, bytes: 0, gzipBytes: 0 }
    byExtension[extension].files++
    byExtension[extension].bytes += file.bytes
    byExtension[extension].gzipBytes += file.gzipBytes
  }
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    byExtension: sortedObject(byExtension),
    largestFiles: [...files]
      .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, 10),
    skippedSymlinks,
    skippedSpecialFiles,
    skippedSensitivePaths,
  }
}

function numericDifferences(previous, current, prefix = "") {
  const changes = []
  for (const key of [
    ...new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})]),
  ].sort()) {
    const before = previous?.[key]
    const after = current?.[key]
    const field = prefix ? `${prefix}.${key}` : key
    if (typeof before === "number" || typeof after === "number") {
      if (before !== after)
        changes.push({
          field,
          before: before ?? null,
          after: after ?? null,
          delta: typeof before === "number" && typeof after === "number" ? after - before : null,
        })
    } else if (
      (before && typeof before === "object" && !Array.isArray(before)) ||
      (after && typeof after === "object" && !Array.isArray(after))
    ) {
      changes.push(...numericDifferences(before, after, field))
    }
  }
  return changes
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  await assertPlainPath(options.repo, "directory")
  const gitRoot = git(options.repo, ["rev-parse", "--show-toplevel"])
  if (path.resolve(gitRoot) !== options.repo)
    throw new Error("--repo must be the Git repository root")
  const packagePath = path.join(options.repo, "package.json")
  await assertPlainPath(packagePath, "file")
  const pkg = JSON.parse(await readFile(packagePath, "utf8"))
  const tracked = git(options.repo, ["ls-files", "-z"]).split("\0").filter(Boolean)
  const source = tracked.filter((file) => file.startsWith("src/"))
  const sourceByExtension = {}
  for (const file of source) increment(sourceByExtension, path.extname(file) || "(none)")
  const dependencies = {
    runtime: Object.keys(pkg.dependencies ?? {}).length,
    development: Object.keys(pkg.devDependencies ?? {}).length,
    optional: Object.keys(pkg.optionalDependencies ?? {}).length,
    peer: Object.keys(pkg.peerDependencies ?? {}).length,
  }
  dependencies.runtimeAndDevelopment = dependencies.runtime + dependencies.development
  const outputs = {}
  for (const output of [...options.outputs].sort((left, right) => left.localeCompare(right))) {
    // Containment makes output labels portable and prevents inadvertently
    // inventorying unrelated directories such as the user's home directory.
    const relative = path.relative(options.repo, output)
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("--output must be a directory inside --repo")
    if (relative.split(path.sep).some((part) => part === "node_modules" || part === ".git"))
      throw new Error("Package implementations and Git internals are not output directories")
    outputs[relative.split(path.sep).join("/")] = await inventoryOutput(output)
  }
  const measurement = {
    schemaVersion: 1,
    repository: {
      head: git(options.repo, ["rev-parse", "HEAD"]),
      dirty: git(options.repo, ["status", "--porcelain=v1", "--untracked-files=normal"]) !== "",
    },
    toolchain: {
      node: process.version,
      zlib: process.versions.zlib,
      gzipLevel: 9,
      gzipMethod: "sum of independent per-file gzip streams",
    },
    hashes: {
      packageJsonSha256: await hashFile(packagePath),
      pnpmLockSha256: await hashFile(path.join(options.repo, "pnpm-lock.yaml")),
    },
    dependencies,
    source: {
      trackedFiles: tracked.length,
      trackedSrcFiles: source.length,
      sourceCodeFiles: source.filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file)).length,
      testFiles: source.filter((file) => file.includes(".test.")).length,
      localeFiles: source.filter((file) => file.startsWith("src/locales/")).length,
      byExtension: sortedObject(sourceByExtension),
    },
    outputs,
  }
  if (options.baseline) {
    await assertPlainPath(options.baseline, "file")
    const saved = JSON.parse(await readFile(options.baseline, "utf8"))
    const baseline = saved.measurement ?? saved
    if (baseline.schemaVersion !== 1) throw new Error("Unsupported baseline schema version")
    measurement.comparison = {
      baselineProductRevision:
        saved.provenance?.productRevision ?? baseline.repository?.head ?? null,
      numericChanges: numericDifferences(
        { dependencies: baseline.dependencies, source: baseline.source, outputs: baseline.outputs },
        { dependencies, source: measurement.source, outputs },
      ),
      note: "Only numeric metrics are compared. Largest-file arrays, provenance, hashes and dirty state are excluded. Check hashes/toolchain separately; size deltas do not measure runtime performance.",
    }
  }
  console.log(JSON.stringify(measurement, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
