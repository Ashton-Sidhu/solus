import { describe, expect, it } from "vite-plus/test";

import {
  isPasteAsTextShortcut,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_LINE_BREAKS,
  pastedTextDisposition,
} from "./textPaste.ts";

describe("isPasteAsTextShortcut", () => {
  it("accepts the V key on non-Latin layouts but follows the letter on Latin ones", () => {
    const chord = { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };
    expect(isPasteAsTextShortcut({ ...chord, key: "М", code: "KeyV" }, false)).toBe(true);
    expect(isPasteAsTextShortcut({ ...chord, key: "k", code: "KeyV" }, false)).toBe(false);
    expect(isPasteAsTextShortcut({ ...chord, key: "V", code: "Period" }, false)).toBe(true);
  });
});

describe("pastedTextDisposition", () => {
  // WHY: a few hundred lines of prose stays under the byte threshold but is
  // too long to read or edit in the composer.
  it("attaches a paste with many short lines although it is under the byte threshold", () => {
    const text = "short line\n".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_LINE_BREAKS);
    expect(text.length).toBeLessThan(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    expect(pastedTextDisposition({ text, canAttach: true })).toBe("attachment");
  });

  it("keeps a paste one line break under the line threshold inline", () => {
    const text = "short line\n".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_LINE_BREAKS - 1);
    expect(pastedTextDisposition({ text, canAttach: true })).toBe("inline");
  });

  it("keeps a long paste inline when the user pastes as text", () => {
    const text = "short line\n".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_LINE_BREAKS);
    expect(pastedTextDisposition({ text, canAttach: true, bypassAutoAttachment: true })).toBe(
      "inline",
    );
  });
});
