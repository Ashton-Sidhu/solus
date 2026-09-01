import { describe, expect, test } from "bun:test";
import {
  fileChipParts,
  tokenizeMarkdownText,
} from "@solus/workspace-ui/components/conversation/lib/markdown-text";

describe("user message inline tokens", () => {
  test("keeps a colon-qualified slash command in one chip", () => {
    // WHY: the sent message must preserve the same single action chip that the
    // user saw in the composer before sending it.
    expect(tokenizeMarkdownText("Run /review:session now")).toEqual([
      { type: "text", value: "Run " },
      { type: "slash", command: "/review:session" },
      { type: "text", value: " now" },
    ]);
  });

  test("does not turn a path or incomplete qualifier into a slash chip", () => {
    expect(tokenizeMarkdownText("/usr/local /review:")).toEqual([
      { type: "text", value: "/usr/local /review:" },
    ]);
  });

  test("a copied file chip carries the whole path, not the basename", () => {
    // WHY: the chip shows only the basename, so copying a sentence around it
    // used to paste a bare filename that no longer names a file. The parts a
    // browser concatenates must re-read as the same chip.
    for (const path of [
      "src/renderer/App.svelte",
      "App.svelte",
      "src/renderer/",
      "~/notes.md",
    ]) {
      const parts = fileChipParts(path);
      const copied = `${parts.prefix}${parts.label}${parts.suffix}`;

      expect(copied).toBe(`@${path}`);
      expect(tokenizeMarkdownText(copied)).toEqual([{ type: "file", path }]);
    }
  });

  test("shows the folder name on a folder chip, not the trailing slash", () => {
    expect(fileChipParts("src/renderer/")).toEqual({
      prefix: "@src/",
      label: "renderer",
      suffix: "/",
    });
  });
});
