import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// A separate tools directory can supply Sharp without changing extension dependencies.
// See docs/branding/README.md for the pinned renderer and regeneration command.
const sharpModule = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "sharp"
const { default: sharp } = await import(sharpModule)
const root = fileURLToPath(new URL("../", import.meta.url))
const full = await readFile(resolve(root, "src/assets/icons/lingotori.svg"), "utf8")
const compact = await readFile(resolve(root, "src/assets/icons/lingotori-compact.svg"), "utf8")
const activeMark = `
  <circle cx="105" cy="117" r="20" fill="#1d626b" stroke="#fffdf7" stroke-width="5"/>
  <path d="M96 117L103 124L115 110" fill="none" stroke="#fffdf7" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
`

async function render(svg, size, destination) {
  await sharp(Buffer.from(svg), { density: 288 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(resolve(root, destination))
}

for (const size of [16, 32, 48, 96, 128]) {
  const svg = size <= 32 ? compact : full
  await render(svg, size, `public/icon/${size}.png`)
  if (size <= 48) {
    await render(
      svg.replace("</svg>", `${activeMark}</svg>`),
      size,
      `public/icon/${size}-active.png`,
    )
  }
}
await render(full, 256, "src/assets/icons/lingotori.png")
