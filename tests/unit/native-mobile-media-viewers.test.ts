// Adapted from T3 Code apps/mobile/src/lib/mediaActions.test.ts, markdownMedia.test.ts,
// src/features/threads/markdownImageSize.test.ts, and
// src/features/pull-requests/pullRequestMediaSource.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { describe, expect, it } from "bun:test";

import type { FilePreviewItem } from "../../apps/mobile/src/components/FilePreview.types";
import { pullRequestImageGallery } from "../../apps/mobile/src/features/prs/lib/pull-request-markdown";
import { resolveSvgImageSize } from "../../apps/mobile/src/features/threads/markdownImageSize";
import { filePreviewGallery, filePreviewName } from "../../apps/mobile/src/lib/filePreviewGallery";
import {
  resolveMarkdownMediaPreview,
  type MarkdownMediaContext,
} from "../../apps/mobile/src/lib/markdownMedia";

const signed: string[] = [];
const hostContext: MarkdownMediaContext = {
  hostFile: (path) =>
    path.startsWith("/forbidden")
      ? null
      : {
          path,
          relativePath: path.startsWith("/") ? undefined : path,
          resolveUri: async () => {
            signed.push(path);
            return `https://host.example/assets/signed?path=${encodeURIComponent(path)}`;
          },
          route: { hostId: "host-1", projectPath: "/repo", path },
        },
};

describe("Markdown media routing", () => {
  it("routes media links to the viewers before ordinary file routing", () => {
    expect(resolveMarkdownMediaPreview("docs/spec.pdf", hostContext)?.kind).toBe("pdf");
    expect(resolveMarkdownMediaPreview("shots/home.png", hostContext)?.kind).toBe("image");
    expect(resolveMarkdownMediaPreview("/tmp/demo.mov", hostContext)?.kind).toBe("video");
    expect(resolveMarkdownMediaPreview("https://example.com/report.pdf", hostContext)?.kind).toBe(
      "pdf",
    );
    // Source files and ordinary web pages keep the file screen and the browser.
    expect(resolveMarkdownMediaPreview("src/index.ts", hostContext)).toBeNull();
    expect(resolveMarkdownMediaPreview("https://example.com/docs", hostContext)).toBeNull();
  });

  it("treats image syntax as an image even without an extension", () => {
    expect(resolveMarkdownMediaPreview("https://example.com/render?id=4", hostContext, true)?.kind).toBe(
      "image",
    );
  });

  it("loads a host file through the URL the host signs, never the path itself", async () => {
    // WHY: the client and the host can be on different machines.
    const preview = resolveMarkdownMediaPreview("docs/spec.pdf", hostContext);
    if (preview?.kind !== "pdf") throw new Error("expected a PDF preview");
    expect(await preview.source.resolveUri()).toBe(
      "https://host.example/assets/signed?path=docs%2Fspec.pdf",
    );
    expect(signed).toContain("docs/spec.pdf");
    expect(preview.source.actionsSource).toMatchObject({
      reference: { kind: "file", path: "docs/spec.pdf", relativePath: "docs/spec.pdf" },
      mimeType: "application/pdf",
      file: { hostId: "host-1", projectPath: "/repo", path: "docs/spec.pdf" },
    });
  });

  it("gives no viewer for a host file the surface cannot read", () => {
    expect(resolveMarkdownMediaPreview("/forbidden/a.png", hostContext)).toBeNull();
  });

  it("loads a web address through the surface's own resolver", async () => {
    const preview = resolveMarkdownMediaPreview(
      "https://github.com/user-attachments/assets/abc.png",
      { hostFile: () => null, webUrl: async (url) => `https://host.example/github?u=${url}` },
    );
    if (preview?.kind !== "image") throw new Error("expected an image preview");
    expect(await preview.source.resolveUri()).toBe(
      "https://host.example/github?u=https://github.com/user-attachments/assets/abc.png",
    );
  });
});

function image(key: string, name?: string): FilePreviewItem {
  return { kind: "image", key, name, resolveUri: async () => key };
}

describe("file preview gallery", () => {
  it("keeps document order, lists each image once, and keeps the tapped image's metadata", () => {
    const first = image("https://example.com/a.png");
    const second = image("https://example.com/b.png");
    const tapped = { ...image("https://example.com/b.png", "B"), sourceNote: true };
    const gallery = filePreviewGallery(tapped, [first, second, first]);
    expect(gallery.map((item) => item.key)).toEqual([first.key, second.key]);
    expect(gallery[1]).toBe(tapped);
  });

  it("puts an image outside the group first and opens a document alone", () => {
    const outside = image("https://example.com/z.png");
    expect(filePreviewGallery(outside, [image("https://example.com/a.png")])[0]).toBe(outside);
    const pdf: FilePreviewItem = { ...image("docs/spec.pdf"), kind: "pdf" };
    expect(filePreviewGallery(pdf, [image("https://example.com/a.png")])).toEqual([pdf]);
  });

  it("names a file for the native viewer by its type, not by caption punctuation", () => {
    expect(filePreviewName(image("https://example.com/shot.png?sig=1", "After v2.1"))).toBe(
      "shot.png",
    );
    expect(filePreviewName(image("https://example.com/render", "a/b:c"))).toBe("a_b_c");
  });
});

describe("pull request image gallery", () => {
  it("swipes through every image of a body, without videos or bot badges", async () => {
    const body = [
      "![Before](https://example.com/before.png)",
      '<img alt="After" src="https://github.com/user-attachments/assets/9f1">',
      "https://example.com/demo.mp4",
      "![badge](https://static.devin.ai/assets/gh-devin-review-light.svg?v=4)",
    ].join("\n\n");
    const gallery = pullRequestImageGallery(body, {
      hostFile: () => null,
      webUrl: async (url) => `signed:${url}`,
    });
    expect(gallery.map((item) => [item.key, item.name])).toEqual([
      ["https://example.com/before.png", "Before"],
      ["https://github.com/user-attachments/assets/9f1", "After"],
    ]);
    expect(await gallery[1]!.resolveUri()).toBe("signed:https://github.com/user-attachments/assets/9f1");
  });
});

describe("resolveSvgImageSize", () => {
  it("uses pixel dimensions before the viewBox", () => {
    expect(resolveSvgImageSize({ width: "32px", height: "48", viewBox: "0 0 100 100" })).toEqual({
      width: 32,
      height: 48,
    });
  });

  it("uses the viewBox for responsive SVGs", () => {
    expect(
      resolveSvgImageSize({ width: "100%", height: "100%", viewBox: "-10, -20, 120, 240" }),
    ).toEqual({ width: 120, height: 240 });
    expect(resolveSvgImageSize({ viewBox: "0 0 100 NaN" })).toBeNull();
    expect(resolveSvgImageSize({ viewBox: "0 0 0 100" })).toBeNull();
  });
});
