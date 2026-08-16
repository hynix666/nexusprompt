import { describe, expect, it } from "vitest";

describe("hosted provider credential boundary", () => {
  it("does not rely on browser-exposed hosted-provider credential variables", () => {
    expect(process.env.VITE_OPENAI_API_KEY).toBeUndefined();
    expect(process.env.VITE_ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.VITE_GEMINI_API_KEY).toBeUndefined();
    expect(process.env.VITE_COMPATIBLE_OPENAI_API_KEY).toBeUndefined();
  });
});
