import { describe, expect, test } from "bun:test";
import {
  fileFindPosition,
  isFileFindShortcut,
  shouldRestoreFileEditorFocus,
} from "../../src/renderer/components/artifact/lib/file-find";

describe("file editor find", () => {
  test("uses the same 8px top inset as the conversation find bar", () => {
    expect(fileFindPosition({ top: 40, left: 600, width: 420 })).toEqual({
      top: 48,
      left: 600,
      width: 420,
    });
  });

  test("isolates primary-modifier find without swallowing replace shortcuts", () => {
    expect(
      isFileFindShortcut({
        code: "KeyF",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isFileFindShortcut({
        code: "KeyF",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isFileFindShortcut({
        code: "KeyF",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
      }),
    ).toBe(false);
  });

  test("returns focus to the editor only when find closes", () => {
    expect(shouldRestoreFileEditorFocus(true, false)).toBe(true);
    expect(shouldRestoreFileEditorFocus(false, true)).toBe(false);
    expect(shouldRestoreFileEditorFocus(true, true)).toBe(false);
  });
});
