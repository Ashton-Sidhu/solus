import { describe, expect, mock, test } from "bun:test";

mock.module("../../packages/workspace-ui/src/lib/inputFocus", () => ({ requestInputFocus() {} }));
const { linkActivation, linkDestinationLabel } = await import(
  "../../packages/workspace-ui/src/components/editor/lib/link-preview"
);

const PLAIN = { metaKey: false, ctrlKey: false };

describe("document link preview", () => {
  test("plain click previews a link while platform modifiers open it directly", () => {
    // WHY: editable documents must preserve safe plain-click behavior while
    // still giving keyboard-first users a fast path to the destination.
    expect(linkActivation("https://example.com", PLAIN)).toEqual({ kind: "preview" });
    expect(linkActivation("https://example.com", { metaKey: true, ctrlKey: false })).toEqual({ kind: "open" });
    expect(linkActivation("https://example.com", { metaKey: false, ctrlKey: true })).toEqual({ kind: "open" });
    expect(linkActivation("mailto:hello@example.com", PLAIN)).toEqual({ kind: "preview" });
  });

  test("a file path opens in the file pane, never in the operating system", () => {
    // WHY: a path names a file on the host. The client may be on another
    // device, so handing the path to the OS opens nothing or the wrong file.
    expect(linkActivation("/Users/me/project/plans/review.md", PLAIN)).toEqual({
      kind: "file",
      path: "/Users/me/project/plans/review.md",
      line: undefined,
    });
    expect(linkActivation("/Users/me/project/plans/review.md", { metaKey: true, ctrlKey: false }).kind).toBe("file");
    expect(linkActivation("file:///Users/me/a%20b.ts", PLAIN)).toEqual({ kind: "file", path: "/Users/me/a b.ts", line: undefined });
    expect(linkActivation("src/foo.ts:12", PLAIN)).toEqual({ kind: "file", path: "src/foo.ts", line: 12 });
  });

  test("the preview names common web and email destinations", () => {
    expect(linkDestinationLabel("https://www.example.com/docs/start")).toBe("example.com");
    expect(linkDestinationLabel("mailto:hello@example.com")).toBe("hello@example.com");
    expect(linkDestinationLabel("relative-page.md")).toBe("relative-page.md");
  });
});
