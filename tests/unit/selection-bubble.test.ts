import { describe, expect, test } from "bun:test";
import { selectionRect } from "@solus/workspace-ui/components/document-shell/lib/selection-bubble";

function editorWithSelection(type: string, isSameParent: boolean) {
  return {
    state: {
      selection: {
        empty: false,
        toJSON: () => ({ type }),
        $from: { sameParent: () => isSameParent },
        $to: {},
      },
    },
    view: {
      coordsAtPos: () => {
        throw new Error("Structured selections must not trigger layout reads");
      },
    },
  } as unknown as Parameters<typeof selectionRect>[0];
}

describe("selection bubble", () => {
  test("structural selections do not measure DOM ranges", () => {
    // Tables, code blocks, and drag-handle node ranges are document structure,
    // not inline formatting targets. Measuring their browser DOM range caused
    // Chromium to hang before application error handling could run.
    expect(selectionRect(editorWithSelection("node", true))).toBeNull();
    expect(selectionRect(editorWithSelection("cell", true))).toBeNull();
    expect(selectionRect(editorWithSelection("nodeRange", true))).toBeNull();
  });

  test("text spanning separate blocks does not measure through structured content", () => {
    expect(selectionRect(editorWithSelection("text", false))).toBeNull();
  });
});
