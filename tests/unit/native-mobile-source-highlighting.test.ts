// Adapted from T3 Code apps/mobile/src/features/files/sourceHighlightingState.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, it, mock } from "bun:test";
import {
  createSourceHighlightCache,
  type SourceHighlightTokens,
} from "../../apps/mobile/src/features/files/sourceHighlightingState";

const highlightedTokens: SourceHighlightTokens = [
  [{ content: "const", color: "#0000ff", fontStyle: null }],
];
const input = { path: "src/example.ts", contents: "const value = 1;", theme: "light" as const };

describe("source highlighting cache", () => {
  it("reuses completed highlighting across equivalent remounts", async () => {
    // WHY: reopening a file must show colors in its first render, not repeat
    // the highlight and flash plain text.
    const highlight = mock(async () => highlightedTokens);
    const cache = createSourceHighlightCache({ highlight });
    expect(cache.peek(input)).toBeNull();
    expect(await cache.load(input)).toEqual({ status: "ready", tokens: highlightedTokens });
    expect(cache.peek({ ...input })).toEqual({ status: "ready", tokens: highlightedTokens });
    expect(highlight).toHaveBeenCalledTimes(1);
  });

  it("does not reuse highlighting when the source contents or theme change", async () => {
    const highlight = mock(async () => highlightedTokens);
    const cache = createSourceHighlightCache({ highlight });
    await cache.load(input);
    await cache.load({ ...input, contents: "const value = 2;" });
    await cache.load({ ...input, theme: "dark" });
    expect(highlight).toHaveBeenCalledTimes(3);
  });

  it("recomputes highlighting after the idle entry expires", async () => {
    let now = 0;
    const highlight = mock(async () => highlightedTokens);
    const cache = createSourceHighlightCache({ highlight, idleTtlMs: 5, now: () => now });
    await cache.load(input);
    now = 10;
    await cache.load(input);
    expect(highlight).toHaveBeenCalledTimes(2);
  });

  it("reports a failed highlight as plain text", async () => {
    const cache = createSourceHighlightCache({
      highlight: async () => {
        throw new Error("no grammar");
      },
    });
    expect(await cache.load(input)).toEqual({ status: "error", tokens: null });
    expect(cache.peek(input)).toEqual({ status: "error", tokens: null });
  });
});

describe("source file language", () => {
  it("colors a file by its name or extension and leaves unknown types plain", async () => {
    // WHY: T3 read the language from `@pierre/diffs`; the local map must still
    // pick a grammar for common files, or the viewer silently shows plain text.
    const { highlightSourceFile } = await import(
      "../../apps/mobile/src/features/review/shikiReviewHighlighter"
    );
    const colors = async (path: string, contents: string) =>
      new Set(
        (await highlightSourceFile({ path, contents, theme: "dark" }))
          .flat()
          .map((token) => token.color),
      ).size;
    expect(await colors("src/app.ts", "const value: number = 1;")).toBeGreaterThan(1);
    expect(await colors("build/Dockerfile", "FROM node:22\nRUN echo hi")).toBeGreaterThan(1);
    expect(await colors("src/Main.kt", "fun main() { println(\"hi\") }")).toBeGreaterThan(1);
    expect(await colors("notes.unknownext", "const value = 1;")).toBe(1);
  });
});

describe("source file batches", () => {
  it("keeps colors for a block comment that spans highlight batches", async () => {
    // WHY: a large file is tokenized in batches; a batch that starts from a
    // fresh grammar state colors the rest of an open comment as code.
    const { highlightSourceFile } = await import(
      "../../apps/mobile/src/features/review/shikiReviewHighlighter"
    );
    const body = Array.from({ length: 400 }, (_, index) => `const insideComment${index} = 1;`);
    const highlighted = await highlightSourceFile({
      path: "example.ts",
      contents: ["/*", ...body, "*/", "const after = 2;"].join("\n"),
      theme: "dark",
    });
    const commentColors = new Set(
      highlighted.slice(1, -2).flatMap((line) => line.map((token) => token.color)),
    );
    expect(commentColors.size).toBe(1);
    expect(highlighted.at(-1)?.map((token) => token.color)).not.toEqual(
      highlighted[1]?.map((token) => token.color),
    );
  });

  it("colors the code after a skipped long line from a fresh state", async () => {
    // WHY: a line too long to tokenize stays plain and its ending state is
    // unknown; the code after it must still be colored as code.
    const { highlightSourceFile } = await import(
      "../../apps/mobile/src/features/review/shikiReviewHighlighter"
    );
    const longLine = `const value = "${"a".repeat(1_100)}";`;
    const highlighted = await highlightSourceFile({
      path: "example.ts",
      contents: ["const before = 1;", longLine, "const after = 2;"].join("\n"),
      theme: "dark",
    });
    expect(highlighted).toHaveLength(3);
    expect(highlighted[1]).toEqual([{ content: longLine, color: null, fontStyle: null }]);
    expect(highlighted[2]?.map((token) => token.color)).toEqual(
      highlighted[0]?.map((token) => token.color),
    );
  });
});
