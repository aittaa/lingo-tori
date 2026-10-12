import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/postcss"
import postcss from "postcss"
import { beforeAll, describe, expect, it } from "vitest"

// Historical names can occur in stored custom CSS, including intermediate scale steps.
const STANDARD_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const LEGACY_STEPS = {
  neutral: STANDARD_STEPS,
  lemon: [...STANDARD_STEPS, 450, 550, 650],
  cornflower: [...STANDARD_STEPS, 450, 550],
  blue: [...STANDARD_STEPS, 450, 550],
}
const definitions = new Map<string, string>()

function resolveProperty(name: string, visited = new Set<string>()): string {
  if (visited.has(name)) throw new Error(`Circular custom property: ${name}`)
  const value = definitions.get(name)
  if (!value) throw new Error(`Missing custom property: ${name}`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  const target = alias?.[1]
  return target ? resolveProperty(target, new Set([...visited, name])) : value
}

beforeAll(async () => {
  const path = fileURLToPath(new URL("../theme.css", import.meta.url))
  const result = await postcss([tailwindcss()]).process(await readFile(path, "utf8"), {
    from: path,
  })
  result.root.walkRules((rule) => {
    if (!rule.selector.split(",").some((selector) => [":root", ":host"].includes(selector.trim())))
      return
    rule.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) definitions.set(declaration.prop, declaration.value)
    })
  })
}, 10000)

describe("saved custom CSS palette compatibility", () => {
  it("keeps every historical palette name resolvable in the compiled root/host theme", () => {
    for (const [family, steps] of Object.entries(LEGACY_STEPS)) {
      for (const step of steps) {
        expect(resolveProperty(`--rf-${family}-${step}`)).toMatch(/^oklch\(/)
      }
    }
  })

  it("retains the fixed colour values used by existing subtitle CSS", () => {
    expect(resolveProperty("--rf-cornflower-450")).toBe("oklch(65.778% 0.17098 265.19)")
    expect(resolveProperty("--rf-lemon-450")).toBe("oklch(82.75% 0.16086 92.055)")
    expect(resolveProperty("--rf-blue-450")).toBe("oklch(66% 0.184 254.753)")
    expect(resolveProperty("--rf-blue-550")).toBe("oklch(58.5% 0.2295 261.348)")
  })

  it("keeps standard aliases tied to the same Tailwind palette dependencies", () => {
    expect(resolveProperty("--rf-neutral-500")).toBe(resolveProperty("--color-neutral-500"))
    expect(resolveProperty("--rf-blue-500")).toBe(resolveProperty("--color-blue-500"))
  })
})
