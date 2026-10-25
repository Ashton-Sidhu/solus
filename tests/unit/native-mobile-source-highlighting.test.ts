// Adapted from T3 Code apps/mobile/src/features/files/sourceHighlightingState.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, it, mock } from "bun:test";

import type { HighlightedLines } from "../../apps/mobile/src/lib/highlights";
import { createWasmHighlightsModule } from "./helpers/native-mobile-highlights";

const nativeModule = createWasmHighlightsModule();
mock.module("expo", () => ({ requireOptionalNativeModule: () => nativeModule }));

const { createSourceHighlightCache } = await import(
  "../../apps/mobile/src/features/files/sourceHighlightingState"
);

const highlightedTokens: HighlightedLines = [
  [{ content: "const", color: "#0000ff", fontStyle: null }],
];
const input = { path: "src/example.ts", contents: "const value = 1;", theme: "light" as const };

describe("source highlighting cache", () => {
  it("is ready in the first read when the highlighter answers in the call", () => {
    // WHY: the native lexers answer synchronously, so a file's first render
    // must be colored instead of painting plain text and then colors.
    const highlight = mock(() => highlightedTokens);
    const cache = createSourceHighlightCache({ highlight });
    expect(cache.peek(input)).toEqual({ status: "ready", tokens: highlightedTokens });
    expect(highlight).toHaveBeenCalledTimes(1);
  });

  it("colors a source file with the native lexers in the first read", () => {
    const cache = createSourceHighlightCache();
    const result = cache.peek({ ...input, theme: "dark" });
    expect(result?.status).toBe("ready");
    expect(new Set(result?.tokens?.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  });

  it("reuses completed highlighting across equivalent remounts", async () => {
    // WHY: reopening a file must show colors in its first render, not repeat
    // the highlight and flash plain text (the Shiki fallback is asynchronous).
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
    const rejected = createSourceHighlightCache({
      highlight: async () => {
        throw new Error("no grammar");
      },
    });
    expect(await rejected.load(input)).toEqual({ status: "error", tokens: null });
    expect(rejected.peek(input)).toEqual({ status: "error", tokens: null });

    const thrown = createSourceHighlightCache({
      highlight: () => {
        throw new Error("lexer failed");
      },
    });
    expect(thrown.peek(input)).toEqual({ status: "error", tokens: null });
  });
});
