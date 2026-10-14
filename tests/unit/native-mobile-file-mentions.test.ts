// Adapted from T3 Code packages/shared/src/composerInlineTokens.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, it } from "bun:test";

import { FILE_MENTION_REGEX, fileMentionPath } from "../../apps/mobile/src/lib/fileMentions";
import { resolveMarkdownLinkPresentation } from "../../apps/mobile/src/lib/markdownLinks";

/** Every `@path` mention Enriched's text recognition would link in `text`. */
function mentions(text: string): string[] {
  return [...text.matchAll(new RegExp(FILE_MENTION_REGEX.source, "g"))].map((match) => match[0]);
}

describe("@path mentions in user message text (T3's mention rule)", () => {
  it("links a bare path up to the next whitespace, with or without an extension", () => {
    expect(mentions("Inspect @README.md next")).toEqual(["@README.md"]);
    expect(mentions("Run @Makefile")).toEqual(["@Makefile"]);
    expect(mentions("@AGENTS.md first")).toEqual(["@AGENTS.md"]);
    expect(mentions("Open @./src/foo.ts:12 and @/Users/me/a.md")).toEqual([
      "@./src/foo.ts:12",
      "@/Users/me/a.md",
    ]);
  });

  it("links a quoted path, which may hold spaces and lowercase package text", () => {
    expect(mentions('Open @"my notes/plan v2.md" now')).toEqual(['@"my notes/plan v2.md"']);
    expect(mentions('Inspect @"expo/ui" next')).toEqual(['@"expo/ui"']);
  });

  it("keeps bare @scope/package text as prose", () => {
    // WHY: T3 writes a picked file as a link, so lowercase `@a/b` text is a package.
    for (const text of ["@expo/ui", "@jane/foo.js", "@scope/pkg/sub/path", "@scope/pkg"]) {
      expect(mentions(`Install ${text} now`)).toEqual([]);
    }
    expect(mentions("install @types/node")).toEqual([]);
  });

  it("needs whitespace or the text's edge on both sides", () => {
    // WHY: T3 recognizes a token only between delimiters, so emails and
    // `(@path)` stay prose, and sentence punctuation stays in the path.
    expect(mentions("mail me@example.com")).toEqual([]);
    expect(mentions("See (@docs/A.md)")).toEqual([]);
    expect(mentions("Read @foo.ts.")).toEqual(["@foo.ts."]);
    expect(mentions('Open @"unclosed')).toEqual([]);
    expect(mentions("an @ alone")).toEqual([]);
  });

  it("opens the mentioned path as a file, also without an extension", () => {
    expect(fileMentionPath("@src/Foo.ts")).toBe("src/Foo.ts");
    expect(fileMentionPath('@"a \\"b\\".md"')).toBe('a "b".md');
    expect(fileMentionPath("@scope/pkg")).toBeNull();
    expect(fileMentionPath("src/foo.ts")).toBeNull();
    expect(resolveMarkdownLinkPresentation("@./src/foo.ts:12")).toMatchObject({
      kind: "file",
      path: "./src/foo.ts",
      line: 12,
    });
    expect(resolveMarkdownLinkPresentation("@Makefile")).toMatchObject({
      kind: "file",
      path: "Makefile",
    });
    expect(resolveMarkdownLinkPresentation("@someone")).toMatchObject({
      kind: "file",
      path: "someone",
    });
  });

  it("compiles for the native engines: no variable-width lookbehind", () => {
    // WHY: Enriched drops a pattern whose lookbehind holds `*`, `+`, or `{`.
    const lookbehinds = [...FILE_MENTION_REGEX.source.matchAll(/\(\?<[=!](.*?)\)/g)];
    expect(lookbehinds.length).toBeGreaterThan(0);
    for (const lookbehind of lookbehinds) expect(/[*+{]/.test(lookbehind[1]!)).toBe(false);
    // WHY: java.util.regex reads a bare `[` inside a class as a nested class.
    expect(/\[[^\]]*(?<!\\)\[/.test(FILE_MENTION_REGEX.source)).toBe(false);
  });

  it("fails fast on a long path that is not a mention", () => {
    // WHY: Enriched runs the pattern on the main thread for every message.
    const started = performance.now();
    mentions(`@a/b${"/c".repeat(40)}"`);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
