import process from "node:process"
import ViteYaml from "@modyfi/vite-plugin-yaml"
import { defineConfig } from "wxt"

export default defineConfig({
  srcDir: "src",
  imports: false,
  modules: ["@wxt-dev/module-react", "@wxt-dev/i18n/module"],
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",
    permissions: [
      "storage",
      "unlimitedStorage",
      "tabs",
      "alarms",
      "contextMenus",
      "scripting",
      "webNavigation",
      ...(browser !== "firefox" ? ["sidePanel"] : []),
    ],
    host_permissions: ["*://*/*"],
    web_accessible_resources: [
      {
        resources: ["assets/*.png", "assets/*.svg", "assets/*.webp"],
        matches: ["*://*/*", "file:///*"],
      },
    ],
    ...(browser === "firefox" && {
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
      browser_specific_settings: {
        gecko: {
          id: "lingotori@aittaa",
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["none"] },
        },
      },
    }),
  }),
  zip: {
    includeSources: ["**/*"],
    excludeSources: [
      ".codex/**",
      ".agents/**",
      "docs/local-session-handoff.md",
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "**/*credential*",
      "**/*secret*",
      "**/*.pem",
      "**/*.key",
      "**/*.sqlite*",
      "**/.aws/**",
      "**/.git/**",
      "node_modules/**",
      "repos/**",
      "reference/**",
      "assets/**",
      "readmes/**",
    ],
  },
  hooks: {
    "vite:build:extendConfig": (entrypoints, viteConfig) => {
      const entrypoint = entrypoints.length === 1 ? entrypoints[0] : undefined
      if (entrypoint?.type !== "content-script") return
      const output = viteConfig.build?.rollupOptions?.output
      if (!output) return
      for (const options of Array.isArray(output) ? output : [output]) {
        options.assetFileNames = (asset) =>
          asset.names.some((name) => name.endsWith(".css"))
            ? `content-scripts/${entrypoint.name}.[ext]`
            : "assets/[name]-[hash].[ext]"
      }
    },
  },
  dev: { server: { port: 3333, strictPort: false } },
  vite: () => ({
    plugins: [
      ViteYaml(),
      {
        name: "reject-bundled-credentials",
        buildStart() {
          if (
            Object.keys(process.env).some((key) =>
              /^WXT_.*(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(key),
            )
          )
            throw new Error(
              "Remove credential-bearing WXT environment variables before building. Configure user providers in the extension instead.",
            )
        },
      },
    ],
  }),
})
