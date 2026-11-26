import { describe, expect, test } from "bun:test";
import {
  fileChipParts,
  fileLinkCopyParts,
  fileMentionTarget,
  linkReference,
  tokenizeMarkdownText,
} from "@solus/workspace-ui/components/conversation/lib/markdown-text";
import { parseReferenceTokens } from "@solus/workspace-ui/components/editor/reference-tokens";

describe("user message inline tokens", () => {
  test("keeps a colon-qualified slash command in one chip", () => {
    // WHY: the sent message must preserve the same single action chip that the
    // user saw in the composer before sending it.
    expect(tokenizeMarkdownText("Run /review-guide now")).toEqual([
      { type: "text", value: "Run " },
      { type: "slash", command: "/review-guide" },
      { type: "text", value: " now" },
    ]);
  });

  test("does not turn a path or incomplete qualifier into a slash chip", () => {
    expect(tokenizeMarkdownText("/usr/local /review:")).toEqual([
      { type: "text", value: "/usr/local /review:" },
    ]);
  });

  test("a copied file chip is the whole path, not the basename", () => {
    // WHY: the chip shows only the basename, so copying a sentence around it
    // used to paste a bare filename that no longer names a file. A copied file
    // is its path, wherever it is pasted; a composer restores the mention from
    // the chip's `data-solus-reference`.
    for (const path of [
      "src/renderer/App.svelte",
      "App.svelte",
      "src/renderer/",
      "~/notes.md",
    ]) {
      const parts = fileChipParts(path);
      expect(`${parts.prefix}${parts.label}${parts.suffix}`).toBe(path);
    }
  });

  test("a sent file path with spaces stays one chip, and copies whole", () => {
    // WHY: the composer quotes a path with spaces. The sent message must show
    // the same single chip, and a copy must paste the quoted form back.
    const path = "My Notes/plan v2.md";
    expect(tokenizeMarkdownText(`read @"${path}" now`)).toEqual([
      { type: "text", value: "read " },
      { type: "file", path },
      { type: "text", value: " now" },
    ]);

    const parts = fileChipParts(path);
    expect(parts.label).toBe("plan v2.md");
    expect(`${parts.prefix}${parts.label}${parts.suffix}`).toBe(path);
  });

  test("a file chip with a line suffix opens that line", () => {
    // WHY: `path:12` is how a message points at code; dropping the line opens
    // the file at the top, and keeping it in the path opens nothing.
    expect(fileMentionTarget("src/App.svelte:12")).toEqual({ path: "src/App.svelte", line: 12 });
    expect(fileMentionTarget("src/App.svelte:12-18")).toEqual({ path: "src/App.svelte", line: 12 });
    expect(fileMentionTarget("src/App.svelte")).toEqual({ path: "src/App.svelte" });
    expect(fileMentionTarget("src/renderer/")).toEqual({ path: "src/renderer/" });
  });

  test("a Windows path shows its file name, and copies whole", () => {
    // WHY: a chip split the path on `/` only, so a path from a Windows host
    // showed in full and ran past the edge of the message bubble.
    const path = String.raw`C:\Users\ashto\projects\solus-remote\docs\plan.md`;
    expect(tokenizeMarkdownText(`what is left on\n@${path}`)).toEqual([
      { type: "text", value: "what is left on\n" },
      { type: "file", path },
    ]);

    const parts = fileChipParts(path);
    expect(parts.label).toBe("plan.md");
    expect(`${parts.prefix}${parts.label}${parts.suffix}`).toBe(path);
  });

  test("shows the folder name on a folder chip, not the trailing slash", () => {
    expect(fileChipParts("src/renderer/")).toEqual({
      prefix: "src/",
      label: "renderer",
      suffix: "/",
    });
  });
});

describe("a chip drawn from a link", () => {
  test("carries the reference a paste into the composer restores", () => {
    // WHY: a chip copies as its label, the name a person expects. A paste into
    // a composer must still be the same chip, so the chip carries its
    // reference (`data-solus-reference`): a host chip names its host, and a
    // session chip its session.
    for (const [label, href, kind] of [
      ["studio-mini", "host://ref?serverId=install-1&state=online", "host"],
      ["Editor research", "session://ref?provider=codex&sessionId=s2&cwd=%2Frepo", "session"],
      ["Architecture", "work://ref?workId=w1&type=doc", "work"],
      ["#42 Make typing fast", "pr://ref?number=42", "pr"],
      ["Ship plan", "plan://ref?planId=p1&sessionId=s1&planToolUseId=t1&status=pending", "plan"],
      ["Fix the [beta] build", "task://ref?taskId=t9", "task"],
      ["Daily digest", "automation://ref?automationId=a1", "automation"],
    ] as const) {
      const reference = linkReference(label, href);
      expect(parseReferenceTokens(reference).map((range) => range.token.kind)).toEqual([kind]);
    }
  });
});

describe("file link copy", () => {
  // WHY: a file named in a reply copied as a Markdown link, and one in a user's
  // message as an `@` mention. Every file chip copies as its path, the line it
  // points at kept.
  test("a copied file link is its path, line kept", () => {
    for (const [path, line, shown, copied] of [
      ["src/foo.ts", undefined, "foo.ts", "src/foo.ts"],
      ["src/foo.ts", 12, "foo.ts:12", "src/foo.ts:12"],
      ["docs/a b.md", undefined, "a b.md", "docs/a b.md"],
    ] as const) {
      const parts = fileLinkCopyParts(path, line, shown);
      expect(parts.isLabelCopied).toBe(true);
      expect(`${parts.open}${shown}${parts.close}`).toBe(copied);
    }
  });

  test("a label that is not in the path is replaced by the path in the copy", () => {
    const parts = fileLinkCopyParts("config/app.json", undefined, "the config");
    expect(parts).toEqual({ open: "config/app.json", close: "", isLabelCopied: false });
  });
});
