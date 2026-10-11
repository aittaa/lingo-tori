import { describe, expect, it } from "vitest"
import { migrate } from "../../migration-scripts/v102-to-v103"

describe("independent v102 to v103 compatibility migration", () => {
  it("drops legacy executable layout and speech flags while preserving user configuration", () => {
    const field = {
      id: "term",
      name: "Term",
      type: "string",
      description: "Explain",
      speaking: true,
    }
    const action = {
      id: "dictionary",
      providerId: "my-provider",
      prompt: "{{selection}}",
      outputSchema: [field],
      layout: "<script>untrusted()</script>",
      customData: { keep: true },
    }
    const before = {
      providersConfig: [{ id: "my-provider", apiKey: "test-placeholder" }],
      language: { targetCode: "jpn" },
      selectionToolbar: {
        enabled: true,
        customActions: [action],
        builtInActions: { dictionary: { enabled: true } },
      },
    }
    const snapshot = structuredClone(before)
    const after = migrate(before)
    expect(after).toEqual({
      ...before,
      selectionToolbar: {
        ...before.selectionToolbar,
        customActions: [
          {
            id: "dictionary",
            providerId: "my-provider",
            prompt: "{{selection}}",
            outputSchema: [{ id: "term", name: "Term", type: "string", description: "Explain" }],
            customData: { keep: true },
          },
        ],
      },
    })
    expect(before).toEqual(snapshot)
    expect(migrate(after)).toEqual(after)
  })

  it("does not synthesize a layout for actions without one", () => {
    const before = { selectionToolbar: { customActions: [{ id: "custom", outputSchema: [] }] } }
    expect(migrate(before)).toEqual(before)
    expect(migrate(before).selectionToolbar.customActions[0]).not.toHaveProperty("layout")
  })

  it.each([
    null,
    undefined,
    0,
    "legacy",
    [],
    {},
    { selectionToolbar: null },
    { selectionToolbar: { customActions: null } },
  ])("preserves malformed or missing containers: %j", (value) => {
    expect(migrate(value)).toEqual(value)
  })

  it("preserves malformed entries for the normal validation path", () => {
    const before = {
      selectionToolbar: {
        customActions: [null, "legacy", [], { outputSchema: [null, "legacy", []] }],
      },
    }
    expect(migrate(before)).toEqual(before)
  })
})
