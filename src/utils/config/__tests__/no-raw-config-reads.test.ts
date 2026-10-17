import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// The stored config is read through the status reader (`getLocalConfig`, `getConfigView`,
// `watchConfigStatus`), never as a raw payload: a payload is whatever was written, validated by
// nobody. This scan fails when production code reads or subscribes to `local:config` directly.
//
// Writers are scanned by `no-raw-config-writes.test.ts`. The files allowed below ARE the reader.
const SRC = join(import.meta.dirname, "..", "..", "..")

const ALLOWED = new Set(["utils/config/status.ts", "utils/config/primary-write.ts"])

const RAW_ACCESS = [
  // storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`) and storage.watch<...>(...)
  /storage\s*\.\s*(?:getItem|watch|getMeta)\s*(?:<[^(`]*>)?\s*\(\s*`local:\$\{CONFIG_STORAGE_KEY\}`/,
  /storage\s*\.\s*(?:getItem|watch|getMeta)\s*(?:<[^(`]*>)?\s*\(\s*["']local:config["']/,
  /storageAdapter\s*\.\s*(?:get|watch)\s*(?:<[^(`]*>)?\s*\(\s*CONFIG_STORAGE_KEY/,
  /storage\.local\.get\([^)]*CONFIG_STORAGE_KEY/,
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path)
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe("reading the stored config", () => {
  it("scans the source tree and finds files to scan", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(500)
  })

  it("is done through the status reader everywhere in production code", () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => {
        const text = readFileSync(join(SRC, file), "utf8")
        return RAW_ACCESS.some((pattern) => pattern.test(text))
      })

    expect(offenders).toEqual([])
  })

  it("recognises the raw accesses it is looking for", () => {
    const samples = [
      "const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)",
      "storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (config) => {})",
      'storage.getItem("local:config")',
      "storageAdapter.watch<Config>(CONFIG_STORAGE_KEY, callback)",
    ]
    const unrecognised = samples.filter(
      (sample) => !RAW_ACCESS.some((pattern) => pattern.test(sample)),
    )

    expect(unrecognised).toEqual([])
  })
})
