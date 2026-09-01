import { describe, expect, test } from "bun:test";
import {
  linkActivationAction,
  linkDestinationLabel,
} from "@solus/workspace-ui/components/editor/lib/link-preview";

describe("document link preview", () => {
  test("plain click previews a link while platform modifiers open it directly", () => {
    // WHY: editable documents must preserve safe plain-click behavior while
    // still giving keyboard-first users a fast path to the destination.
    expect(linkActivationAction({ metaKey: false, ctrlKey: false })).toBe("preview");
    expect(linkActivationAction({ metaKey: true, ctrlKey: false })).toBe("open");
    expect(linkActivationAction({ metaKey: false, ctrlKey: true })).toBe("open");
  });

  test("the preview names common web and email destinations", () => {
    expect(linkDestinationLabel("https://www.example.com/docs/start")).toBe("example.com");
    expect(linkDestinationLabel("mailto:hello@example.com")).toBe("hello@example.com");
    expect(linkDestinationLabel("relative-page.md")).toBe("relative-page.md");
  });
});
