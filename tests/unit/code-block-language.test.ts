import { describe, expect, test } from "bun:test";
import { codeBlockPickerLanguage } from "../../src/renderer/components/editor/lib/code-block-language";

describe("code block language picker", () => {
  test("common Markdown fence aliases still select a visible picker label", () => {
    expect(codeBlockPickerLanguage("ts")).toBe("typescript");
    expect(codeBlockPickerLanguage("js")).toBe("javascript");
    expect(codeBlockPickerLanguage("py")).toBe("python");
  });

  test("canonical languages remain unchanged", () => {
    expect(codeBlockPickerLanguage("typescript")).toBe("typescript");
    expect(codeBlockPickerLanguage("yaml")).toBe("yaml");
  });

  test("unsupported fences fall back to the visible plain option", () => {
    expect(codeBlockPickerLanguage("unknown-language")).toBe("");
    expect(codeBlockPickerLanguage(null)).toBe("");
  });
});
