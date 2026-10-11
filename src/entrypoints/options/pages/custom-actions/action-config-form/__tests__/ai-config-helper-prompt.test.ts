import { describe, expect, it } from "vitest"
import { buildAiConfigHelperPrompt } from "../ai-config-helper-prompt"

describe("independent custom-action configuration help", () => {
  it("describes the supported BYOK fields without exporting legacy layout or service metadata", () => {
    const prompt = buildAiConfigHelperPrompt({
      action: {
        id: "example",
        name: "Dictionary",
        enabled: true,
        icon: "tabler:book",
        providerId: "private-provider",
        systemPrompt: "Explain words",
        prompt: "{{selection}}",
        outputSchema: [{ id: "term", name: "Term", type: "string", description: "Meaning" }],
        layout: "PROPRIETARY_LEGACY_SENTINEL",
      },
      otherActionNames: ["Existing"],
      uiLocale: "en",
      targetCode: "jpn",
    })
    expect(prompt).toContain("LingoTori")
    expect(prompt).toContain("string or number")
    expect(prompt).toContain("Existing")
    expect(prompt).toContain("{{selection}}")
    expect(prompt).not.toContain("PROPRIETARY_LEGACY_SENTINEL")
    expect(prompt).not.toContain("private-provider")
    expect(prompt).not.toContain("Read Frog")
    expect(prompt).not.toContain("<style>")
  })
})
