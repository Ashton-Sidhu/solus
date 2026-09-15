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
  expect(raw).toHaveLength(1)
  expect(assistantMarkdownExtensions("<style>body{}</style>\n<div>changed</div>")).toBe(raw)
})
