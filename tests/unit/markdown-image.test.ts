import { describe, expect, test } from "bun:test";
import { markdownAssetId, markdownImageUrl } from "@solus/workspace-ui/components/conversation/lib/markdown-image";

describe("markdown image URLs", () => {
  test("resolves a relative image from the session working directory", () => {
    expect(
      markdownImageUrl(
        ".solus-local/artifacts/workspace.png",
        "/Users/sidhu/solus",
      ),
    ).toBe(
      "solus-artifact://local/?p=%2FUsers%2Fsidhu%2Fsolus%2F.solus-local%2Fartifacts%2Fworkspace.png",
    );
  });

  test("normalizes parent path segments", () => {
    expect(markdownImageUrl("../shot.png", "/repo/worktree")).toBe(
      "solus-artifact://local/?p=%2Frepo%2Fshot.png",
    );
  });

  test("serves an absolute file URL through the local artifact protocol", () => {
    expect(markdownImageUrl("file:///tmp/task-shot.png", undefined)).toBe(
      "solus-artifact://local/?p=%2Ftmp%2Ftask-shot.png",
    );
  });

  test("leaves remote and inline image URLs unchanged", () => {
    expect(markdownImageUrl("https://example.com/shot.png", "/repo")).toBe(
      "https://example.com/shot.png",
    );
    expect(markdownImageUrl("data:image/png;base64,abc", "/repo")).toBe(
      "data:image/png;base64,abc",
    );
  });

  test("leaves relative URLs unchanged without a concrete working directory", () => {
    expect(markdownImageUrl("shot.png", undefined)).toBe("shot.png");
    expect(markdownImageUrl("shot.png", "~")).toBe("shot.png");
  });

  test("recognizes content-addressed attachment references", () => {
    const id = `${"a".repeat(64)}.png`;
    expect(markdownAssetId(`asset://${id}`)).toBe(id);
    expect(markdownAssetId("asset://../../secret.png")).toBeNull();
    expect(markdownAssetId(`asset://${"b".repeat(64)}.svg`)).toBe(`${"b".repeat(64)}.svg`);
  });
});
