import { describe, expect, it, mock } from "bun:test";

mock.module("../../packages/workspace-ui/src/lib/inputFocus", () => ({ requestInputFocus() {} }));
const { filePreviewMediaKind, parseFileHref } = await import("../../packages/workspace-ui/src/lib/filePreview");

describe("media file chip routing", () => {
  it("opens image and video references in the media modal across source types", () => {
    for (const path of ["shots/home.png", "/tmp/home.JPG", "file:///tmp/home.webp", "https://example.com/home.avif?token=abc#preview", `asset://${"a".repeat(64)}.png`, "data:image/png;base64,AA=="]) {
      expect(filePreviewMediaKind(path)).toBe("image");
    }
    for (const path of ["clips/demo.mp4", "/tmp/demo.MOV", "https://example.com/demo.webm?token=abc", `asset://${"a".repeat(64)}.m4v`]) {
      expect(filePreviewMediaKind(path)).toBe("video");
    }
  });

  it("keeps ordinary files and web pages on their existing routes", () => {
    for (const path of ["src/index.ts", "docs/spec.pdf", "https://example.com/docs", "clip.mp4.txt"]) {
      expect(filePreviewMediaKind(path)).toBeNull();
    }
  });

  it("uses the file path without the source line when classifying a file link", () => {
    const file = parseFileHref("/tmp/screenshot.png:12");
    expect(file?.line).toBe(12);
    expect(filePreviewMediaKind(file!.path)).toBe("image");
  });
});
