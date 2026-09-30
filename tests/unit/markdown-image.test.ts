import { describe, expect, test } from "bun:test";
import { isMarkdownVideo, markdownAssetId, markdownImagePath } from "@solus/workspace-ui/components/conversation/lib/markdown-image";
import { standaloneLocalVideoHref, standaloneMarkdownMediaLink } from "@solus/workspace-ui/lib/githubMarkdown";

describe("markdown image paths", () => {
  test("resolves a relative image from the session working directory", () => {
    expect(
      markdownImagePath(".solus-local/artifacts/workspace.png", "/Users/sidhu/solus"),
    ).toBe("/Users/sidhu/solus/.solus-local/artifacts/workspace.png");
  });

  test("normalizes parent path segments", () => {
    expect(markdownImagePath("../shot.png", "/repo/worktree")).toBe("/repo/shot.png");
  });

  test("reads an absolute file URL as a host path", () => {
    expect(markdownImagePath("file:///tmp/task-shot.png", undefined)).toBe("/tmp/task-shot.png");
  });

  test("leaves remote and inline image URLs to the browser", () => {
    expect(markdownImagePath("https://example.com/shot.png", "/repo")).toBeNull();
    expect(markdownImagePath("data:image/png;base64,abc", "/repo")).toBeNull();
  });

  test("leaves relative URLs alone without a concrete working directory", () => {
    expect(markdownImagePath("shot.png", undefined)).toBeNull();
    expect(markdownImagePath("shot.png", "~")).toBeNull();
  });

  test("recognizes content-addressed attachment references", () => {
    const id = `${"a".repeat(64)}.png`;
    expect(markdownAssetId(`asset://${id}`)).toBe(id);
    expect(markdownAssetId("asset://../../secret.png")).toBeNull();
    expect(markdownAssetId(`asset://${"b".repeat(64)}.svg`)).toBe(`${"b".repeat(64)}.svg`);
  });
});

describe("markdown videos", () => {
  // WHY: an agent embeds a recording as `![caption](/abs/path.mp4)`. Drawn in
  // an <img> it is a broken frame; it has to reach the player.
  test("a local path or asset id with a video extension is a video", () => {
    const path = markdownImagePath("/repo/.solus-local/bug.mov", "/repo");
    expect(isMarkdownVideo("/repo/.solus-local/bug.mov", path, null)).toBe(true);
    const id = `${"d".repeat(64)}.mp4`;
    expect(isMarkdownVideo(`asset://${id}`, null, markdownAssetId(`asset://${id}`))).toBe(true);
    expect(isMarkdownVideo("https://example.com/demo.webm?x=1", null, null)).toBe(true);
  });

  test("an image stays an image", () => {
    const path = markdownImagePath("shot.png", "/repo");
    expect(isMarkdownVideo("shot.png", path, null)).toBe(false);
    expect(isMarkdownVideo(`asset://${"e".repeat(64)}.png`, null, `${"e".repeat(64)}.png`)).toBe(false);
  });

  test("a paragraph that is only a host video plays; prose that names one does not", () => {
    expect(standaloneLocalVideoHref("/tmp/recording.mp4")).toBe("/tmp/recording.mp4");
    expect(standaloneLocalVideoHref(`asset://${"f".repeat(64)}.mp4`)).toBe(`asset://${"f".repeat(64)}.mp4`);
    expect(standaloneLocalVideoHref("![bug](file:///tmp/bug.mov)")).toBe("file:///tmp/bug.mov");
    expect(standaloneLocalVideoHref("See /tmp/recording.mp4 for the bug")).toBeNull();
    expect(standaloneLocalVideoHref("/tmp/notes.md")).toBeNull();
    expect(standaloneLocalVideoHref("https://example.com/a.mp4")).toBeNull();
  });

  test("GitHub recordings keep their existing handling", () => {
    expect(standaloneMarkdownMediaLink("https://github.com/user-attachments/assets/abc")?.provider).toBe("GitHub");
  });
});
