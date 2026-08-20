import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@solus/contracts/types";
import { attachmentLabel } from "../../packages/workspace-ui/src/components/input/lib/attachment-label";

const inputSource = (file: string) =>
  readFileSync(
    join(import.meta.dir, `../../packages/workspace-ui/src/components/input/${file}`),
    "utf8",
  );

function attachment(name: string, type: Attachment["type"] = "image"): Attachment {
  return { id: "attachment", type, name, path: name };
}

describe("attachmentLabel", () => {
  test("removes generated clipboard numbering and extensions", () => {
    expect(attachmentLabel(attachment("pasted image 15.png"))).toBe("Pasted image");
    expect(attachmentLabel(attachment("pasted image.jpeg"))).toBe("Pasted image");
  });

  test("keeps user file names and non-image names intact", () => {
    expect(attachmentLabel(attachment("product mockup.png"))).toBe("product mockup.png");
    expect(attachmentLabel(attachment("pasted image 15.png", "file"))).toBe(
      "pasted image 15.png",
    );
  });
});

describe("attachment chip layout", () => {
  test("keeps the chip row close to the prompt in both input modes", () => {
    // WHY: the normal editor top inset must not be repeated below an attachment.
    // That empty band makes the chip look detached and pushes entered text down.
    const chips = inputSource("AttachmentChips.svelte");
    const inputBar = inputSource("InputBar.svelte");

    expect(chips).toContain('class="flex gap-1.5 overflow-x-auto"');
    expect(chips).not.toContain("pb-1");
    expect(chips).toContain(
      "'relative size-14 pointer-fine:[.is-laptop-display_&]:size-12'",
    );
    expect(chips).toContain(
      "outline-[0.5px] -outline-offset-1 outline-black/20 dark:outline-white/20",
    );
    expect(chips).toContain("absolute top-0 right-0 flex size-4");
    expect(chips).toContain("pointer-fine:[.is-laptop-display_&]:size-3.5");
    expect(inputBar).toContain("[--plain-editor-padding:0.5rem_0_1.25rem_0]");
    expect(inputBar).toContain(
      "[--plain-editor-padding:0.5rem_0_0.9375rem_0.25rem]",
    );
  });
});
