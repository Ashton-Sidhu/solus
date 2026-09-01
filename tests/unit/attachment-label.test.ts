import { describe, expect, test } from "bun:test";
import type { Attachment } from "@solus/contracts/types";
import { attachmentLabel } from "../../packages/workspace-ui/src/components/input/lib/attachment-label";

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
