// Adapted from T3 Code apps/mobile/src/lib/highlights.test.ts (MIT, see apps/mobile/UPSTREAM.md).
// Each case loads a fresh copy of the module (a query string), so the native
// module it finds at load time can differ between cases.
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { codeToTokens } from "@pierre/highlights";
import githubDarkDefault from "@pierre/highlights/themes/github-dark-default";
import githubLightDefault from "@pierre/highlights/themes/github-light-default";

import { createWasmHighlightsModule } from "./helpers/native-mobile-highlights";

let nativeModule: ReturnType<typeof createWasmHighlightsModule> | null = null;
mock.module("expo", () => ({ requireOptionalNativeModule: () => nativeModule }));

const { resolveHighlightLanguage } = await import("../../apps/mobile/src/lib/highlightLanguage");
const { HIGHLIGHTS_THEME_STYLES } = await import("../../apps/mobile/src/lib/highlights.generated");

type Highlights = typeof import("../../apps/mobile/src/lib/highlights");
let loadCount = 0;
function loadHighlights(native: typeof nativeModule): Promise<Highlights> {
  nativeModule = native;
  return import(`../../apps/mobile/src/lib/highlights.ts?case=${loadCount++}`);
}

const plain = (content: string) => ({ content, color: null, fontStyle: null });

describe("highlightCode with the native lexers", () => {
  const native = createWasmHighlightsModule();

  it("returns @pierre/highlights' own tokens in web's colors in the call", async () => {
    // WHY: web colors code with these lexers and themes; the first frame on
    // mobile must already show the same colors, so the answer cannot wait.
    const { highlightCode } = await loadHighlights(native);
    const code = [
      "/** 🎉 docs\r",
      " */",
      "export const greet = (name: string) => <b title={`hi ${name}`}>é</b>;",
      "const multi = `first",
      "second`; // done",
      "",
    ].join("\n");

    for (const [scheme, theme] of [
      ["light", githubLightDefault],
      ["dark", githubDarkDefault],
    ] as const) {
      const expected = codeToTokens(code, { lang: "tsx", theme }).tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          color: token.color ?? null,
          fontStyle: token.fontStyle ?? null,
        })),
      );
      const lines = highlightCode(code, "tsx", scheme);
      expect(lines).not.toBeInstanceOf(Promise);
      expect(lines).toEqual(expected);
    }
  });

  it("decodes (endUtf16, tokenId) records, where a line-end record names the next line's start", async () => {
    const { decodeHighlightRecords } = await loadHighlights(native);
    const LINE_END = 0xffffffff;
    // "ab" is token 5, the CRLF ends line 1, and line 2 starts at offset 4.
    const records = new Uint32Array([2, 5, 4, LINE_END, 5, 1, 6, 0]);
    const [color5, fontStyle5] = HIGHLIGHTS_THEME_STYLES.dark[5];
    const [color1, fontStyle1] = HIGHLIGHTS_THEME_STYLES.dark[1];
    const [color0, fontStyle0] = HIGHLIGHTS_THEME_STYLES.dark[0];

    expect(decodeHighlightRecords("ab\r\ncd", records, "dark")).toEqual([
      [{ content: "ab", color: color5, fontStyle: fontStyle5 }],
      [
        { content: "c", color: color1, fontStyle: fontStyle1 },
        { content: "d", color: color0, fontStyle: fontStyle0 },
      ],
    ]);
  });

  it("keeps an over-long line as one plain token and colors the lines after it", async () => {
    // WHY: a minified line must not become thousands of native text runs, but
    // the code after it is still code.
    const { highlightCode } = await loadHighlights(native);
    const longLine = `const data = "${"x".repeat(1_000)}";`;
    const lines = highlightCode(`let a = 1;\n${longLine}\nlet b = 2;`, "typescript", "dark");
    if (lines instanceof Promise) throw new Error("expected tokens in the call");

    expect(lines[0].length).toBeGreaterThan(1);
    expect(lines[1]).toEqual([plain(longLine)]);
    expect(lines[2].map((token) => token.color)).toEqual(lines[0].map((token) => token.color));
  });

  it("colors a file by its name or extension and leaves unknown types plain", async () => {
    // WHY: the language comes from the same file-type table web uses; a file
    // it cannot place must show plain text rather than another language's colors.
    const { highlightCode } = await loadHighlights(native);
    const colors = (path: string, contents: string) => {
      const lines = highlightCode(contents, resolveHighlightLanguage({ path }), "dark");
      if (lines instanceof Promise) throw new Error("expected tokens in the call");
      return new Set(lines.flat().map((token) => token.color)).size;
    };

    expect(colors("src/app.ts", "const value: number = 1;")).toBeGreaterThan(1);
    expect(colors("build/Dockerfile", "FROM node:22\nRUN echo hi")).toBeGreaterThan(1);
    expect(colors("src/Main.kt", 'fun main() { println("hi") }')).toBeGreaterThan(1);
    expect(resolveHighlightLanguage({ path: "notes.unknownext" })).toBe("text");
    expect(resolveHighlightLanguage({ path: "settings.ini" })).toBe("text");
    expect(resolveHighlightLanguage({ language: " TSX ", path: "notes.unknownext" })).toBe("tsx");
    expect(highlightCode("const value = 1;", "text", "dark")).toEqual([[plain("const value = 1;")]]);
  });
});

describe("highlightCode without the native module", () => {
  // Shiki keeps the rest of a line as one token once the line takes 500 ms.
  // Its JavaScript engine compiles a grammar's patterns on first use, which a
  // loaded test run can make that slow, so the grammar compiles first.
  beforeAll(async () => {
    const { highlightCode } = await loadHighlights(null);
    await highlightCode("/* a */ const value: number = `b${1}`;", "typescript", "dark");
  });

  it("colors code with Shiki's JavaScript engine", async () => {
    // WHY: Expo Go and a binary built before the module still show colored
    // code after a JavaScript update, instead of crashing or going plain.
    const { highlightCode } = await loadHighlights(null);
    const source = "const value: number = 1;";
    const result = highlightCode(source, "ts", "dark");
    expect(result).toBeInstanceOf(Promise);

    const lines = await result;
    expect(lines.flat().map((token) => token.content).join("")).toBe(source);
    expect(new Set(lines.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  });

  it("answers plain text in the call for a language without a lexer", async () => {
    const { highlightCode } = await loadHighlights(null);
    expect(highlightCode("key = value\n", "text", "light")).toEqual([[plain("key = value")], []]);
  });

  it("keeps colors for a block comment that spans highlight batches", async () => {
    // WHY: the fallback tokenizes a large file in batches; a batch that starts
    // from a fresh grammar state colors the rest of an open comment as code.
    const { highlightCode } = await loadHighlights(null);
    const body = Array.from({ length: 400 }, (_, index) => `const insideComment${index} = 1;`);
    const highlighted = await highlightCode(["/*", ...body, "*/", "const after = 2;"].join("\n"), "typescript", "dark");
    const commentColors = new Set(
      highlighted.slice(1, -2).flatMap((line) => line.map((token) => token.color)),
    );

    expect(commentColors.size).toBe(1);
    expect(highlighted.at(-1)?.map((token) => token.color)).not.toEqual(
      highlighted[1]?.map((token) => token.color),
    );
  });

  it("colors the code after a skipped long line from a fresh state", async () => {
    const { highlightCode } = await loadHighlights(null);
    const longLine = `const value = "${"a".repeat(1_100)}";`;
    const highlighted = await highlightCode(
      ["const before = 1;", longLine, "const after = 2;"].join("\n"),
      "typescript",
      "dark",
    );

    expect(highlighted).toHaveLength(3);
    expect(highlighted[1]).toEqual([plain(longLine)]);
    expect(highlighted[2]?.map((token) => token.color)).toEqual(
      highlighted[0]?.map((token) => token.color),
    );
  });

  it("returns no lines once the request is aborted", async () => {
    const { highlightCode } = await loadHighlights(null);
    const controller = new AbortController();
    controller.abort();
    expect(await highlightCode("const value = 1;", "typescript", "dark", controller.signal)).toEqual([]);
  });
});
