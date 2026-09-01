import { describe, expect, test } from "bun:test";
import { dictationInsertion } from "../../packages/workspace-ui/src/components/input/lib/dictation-text";

describe("dictationInsertion", () => {
  test("adds one separator before speech when existing text has no trailing space", () => {
    expect(dictationInsertion("new words", "existing text")).toBe(" new words");
  });

  test("does not add a second separator after existing whitespace", () => {
    expect(dictationInsertion("new words", "existing text ")).toBe("new words");
  });

  test("separates speech from text after the caret", () => {
    expect(dictationInsertion("new words", "existing ", "text")).toBe(
      "new words ",
    );
    expect(dictationInsertion("new words", "existing ", " text")).toBe(
      "new words",
    );
  });

  test("trims speech and ignores empty transcripts", () => {
    expect(dictationInsertion("  spoken text  ", "")).toBe("spoken text");
    expect(dictationInsertion("   ", "existing text")).toBe("");
  });
});
