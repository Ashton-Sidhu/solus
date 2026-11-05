import { describe, expect, test } from "bun:test";
import { codeFileLinkLabel, assistantMarkdownExtensions } from "@solus/workspace-ui/components/conversation/lib/assistant-markdown";

describe("assistant markdown", () => {
  test("flattens a code-formatted file-link label so it cannot create a nested file chip", () => {
    expect(codeFileLinkLabel("`client-core/ws-transport.ts:232`", 232)).toBe(
      "client-core/ws-transport.ts",
    );
    expect(codeFileLinkLabel("plain label", 232)).toBeNull();
  });
});

test("uses stable parser configuration for prose and fenced HTML, and a full pass for raw HTML", () => {
  const prose = assistantMarkdownExtensions("A paragraph.\n\n")
  expect(prose).toHaveLength(0)
  expect(assistantMarkdownExtensions("A paragraph.\n\nAnother.")).toBe(prose)
  expect(assistantMarkdownExtensions("```html\n<style>body{}</style>\n```\n")).toBe(prose)
  const raw = assistantMarkdownExtensions("<style>body{}</style>\n<div>body</div>")
  expect(raw).toHaveLength(2)
  expect(assistantMarkdownExtensions("<style>body{}</style>\n<div>changed</div>")).toBe(raw)
})

test("a streaming reply gets the same extensions token by token as a fresh scan of the whole text", () => {
  // WHY: the scan runs on every streamed token. It reads only the new text,
  // so it must not miss syntax that spans the old and new text, nor treat a
  // closing fence that is still growing as closed.
  const replies = [
    "Intro\n```\n``` not a close\n<b>inside the fence</b>\n```\nafter\n",
    "Text\n```html\n<div>fenced</div>\n```\nThen <b>raw</b> HTML.",
    "Lead.\n\n>\n\n[!note] a split alert\n",
    "A claim.[^1]\n\n[^1]: The source.",
    "![shot](/tmp/a b.png)\n",
  ];
  const fresh = (text: string) => {
    assistantMarkdownExtensions("\u0000 reset");
    return assistantMarkdownExtensions(text);
  };
  for (const reply of replies) {
    for (let end = 1; end <= reply.length; end++) {
      const partial = reply.slice(0, end);
      assistantMarkdownExtensions("\u0000 reset");
      for (let n = 1; n <= end; n++) assistantMarkdownExtensions(reply.slice(0, n));
      const streamed = assistantMarkdownExtensions(partial);
      expect(streamed, JSON.stringify(partial)).toBe(fresh(partial));
    }
  }
});
