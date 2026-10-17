import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// The stored config, its meta, the backups and the kept originals are changed by one writer: the
// settings service in the background. Every other context sends it a request. This scan fails when
// production code writes the config pair by any other path, or when something other than the
// service and startup calls the primary writer.
const SRC = join(import.meta.dirname, "..", "..", "..")

/** The one module that writes `local:config` and its meta. */
const PRIMARY_WRITER = "utils/config/primary-write.ts"

/** The only modules that may call it: startup, and the service that serializes everything else. */
const PRIMARY_WRITER_CALLERS = new Set([
  "utils/config/init.ts",
  "entrypoints/background/config-commit-service.ts",
])

const RAW_WRITE = [
  // storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, ...) and its meta/remove siblings
  /storage\s*\.\s*(?:setItem|setItems|setMeta|removeItem|removeItems|removeMeta)\s*(?:<[^(`]*>)?\s*\(\s*`local:\$\{CONFIG_STORAGE_KEY\}`/,
  /storage\s*\.\s*(?:setItem|setItems|setMeta|removeItem|removeItems|removeMeta)\s*(?:<[^(`]*>)?\s*\(\s*["']local:config["']/,
  /storageAdapter\s*\.\s*(?:set|remove)\s*(?:<[^(`]*>)?\s*\(\s*CONFIG_STORAGE_KEY/,
  // browser.storage.local.set({ [CONFIG_STORAGE_KEY]: ... }) / .remove(CONFIG_STORAGE_KEY)
  /storage\.local\.(?:set|remove)\(\s*\{?\s*\[?\s*CONFIG(?:_META)?_STORAGE_KEY/,
  /\[\s*CONFIG(?:_META)?_STORAGE_KEY\s*\]\s*:/,
]

const PRIMARY_WRITER_CALL = /\b(?:commitPrimary|commitPrimaryMeta)\b/

/** Backups and kept originals: the modules that define the writers, and who may call them. */
const COPY_WRITER_MODULES = new Set(["utils/backup/storage.ts", "utils/config/preservation.ts"])
const COPY_WRITER_CALLERS = new Set([
  "utils/config/init.ts",
  "entrypoints/background/config-commit-service.ts",
])
const COPY_WRITER_CALL =
  /\b(?:addBackup|removeBackup|clearBackups|clearAllBackups|pruneBackups|preserveOriginal|deletePreservedOriginal)\s*\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path)
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

function production() {
  return sourceFiles(SRC).map((path) => ({
    file: relative(SRC, path),
    text: readFileSync(path, "utf8"),
  }))
}

describe("writing the stored config", () => {
  it("scans the source tree and finds files to scan", () => {
    expect(production().length).toBeGreaterThan(500)
  })

  it("is done by the primary writer and nothing else", () => {
    const offenders = production()
      .filter(({ file }) => file !== PRIMARY_WRITER)
      .filter(({ text }) => RAW_WRITE.some((pattern) => pattern.test(text)))
      .map(({ file }) => file)

    expect(offenders).toEqual([])
  })

  it("is requested of the primary writer only by startup and the settings service", () => {
    const callers = production()
      .filter(({ file }) => file !== PRIMARY_WRITER)
      .filter(({ text }) => PRIMARY_WRITER_CALL.test(text))
      .map(({ file }) => file)
      .sort()

    expect(callers).toEqual([...PRIMARY_WRITER_CALLERS].sort())
  })

  it("also holds for the backups and the kept originals: only the service (and startup, for a kept original) changes them", () => {
    const callers = production()
      .filter(({ file }) => !COPY_WRITER_MODULES.has(file))
      .filter(({ text }) => COPY_WRITER_CALL.test(text))
      .map(({ file }) => file)
      .sort()

    expect(callers).toEqual([...COPY_WRITER_CALLERS].sort())
  })

  it("recognises the raw writes it is looking for", () => {
    const samples = [
      "await storage.setItem<Config>(`local:${CONFIG_STORAGE_KEY}`, config)",
      "await storage.setMeta<Partial<ConfigMeta>>(`local:${CONFIG_STORAGE_KEY}`, { lastModifiedAt })",
      'await storage.removeItem("local:config")',
      "await storageAdapter.set(CONFIG_STORAGE_KEY, config)",
      "await browser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })",
      "await browser.storage.local.remove(CONFIG_META_STORAGE_KEY)",
      "const items = { [CONFIG_STORAGE_KEY]: config }",
    ]
    const unrecognised = samples.filter(
      (sample) => !RAW_WRITE.some((pattern) => pattern.test(sample)),
    )

    expect(unrecognised).toEqual([])
  })

  it("does not take reads for writes", () => {
    const reads = [
      "const items = await browser.storage.local.get([CONFIG_STORAGE_KEY, CONFIG_META_STORAGE_KEY])",
      "const value = await storageAdapter.get(CONFIG_STORAGE_KEY, DEFAULT_CONFIG, configSchema)",
      "storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, callback)",
    ]

    expect(reads.filter((sample) => RAW_WRITE.some((pattern) => pattern.test(sample)))).toEqual([])
  })
})
