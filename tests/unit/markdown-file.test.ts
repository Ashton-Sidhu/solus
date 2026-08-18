import { describe, expect, test } from "bun:test";
import {
  isMarkdownFile,
  initialMarkdownFileViewMode,
  MARKDOWN_FILE_VIEW_OPTIONS,
  markdownFileDirectory,
} from "../../src/renderer/components/files/lib/markdown-file";

describe("Markdown file rendering", () => {
  test("recognizes Markdown files without treating MDX as executable Markdown", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("docs/guide.MARKDOWN#intro")).toBe(true);
    expect(isMarkdownFile("component.mdx")).toBe(false);
  });

  test("opens normal Markdown for reading and exact lines as source", () => {
    expect(initialMarkdownFileViewMode("README.md")).toBe("rendered");
    expect(initialMarkdownFileViewMode("README.md", 24)).toBe("source");
    expect(initialMarkdownFileViewMode("app.ts")).toBe("source");
  });

  test("uses the same Editor and Markdown mode names as document surfaces", () => {
    expect(MARKDOWN_FILE_VIEW_OPTIONS).toEqual([
      { value: "rendered", label: "Editor" },
      { value: "source", label: "Markdown" },
    ]);
  });

  test("uses the document directory for relative image assets", () => {
    expect(markdownFileDirectory("docs/guide.md", "/repo")).toBe("/repo/docs");
    expect(markdownFileDirectory("/tmp/guide.md", "/repo")).toBe("/tmp");
  });
});
