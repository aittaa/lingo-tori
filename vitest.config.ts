import react from "@vitejs/plugin-react"
import { configDefaults, defineConfig } from "vitest/config"
import { WxtVitest } from "wxt/testing/vitest-plugin"

export default defineConfig({
  // TODO: remove any
  // Unit tests do not start a dev server; skip WXT's unnecessary port probe.
  plugins: [WxtVitest({ dev: { server: { port: 3333, strictPort: true } } }) as any, react()],
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/repos/**"],
    environment: "node",
    environmentOptions: {
      // jsdom defaults to http://localhost:3000/, which built-in site rules
      // keyed on localhost (e.g. sillytavern) silently match — tests written
      // on the default URL would run under that site's semantics instead of
      // the shipped defaults. Pin a neutral host no rule matches; per-file
      // @vitest-environment-options pragmas still override this.
      jsdom: { url: "https://neutral-test.example/" },
    },
    globals: true,
    setupFiles: "vitest.setup.ts",
    watch: false,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      // include: ['src/**/*.{ts,tsx}'],
      // exclude: ['src/**/*.spec.ts']
    },
  },
})
