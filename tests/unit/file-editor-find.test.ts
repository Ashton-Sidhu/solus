import { describe, expect, test } from "bun:test";
import {
  fileFindPosition,
  isFileFindShortcut,
  preserveFileFindNavigationFocus,
  shouldRestoreFileEditorFocus,
} from "@solus/workspace-ui/components/artifact/lib/file-find";
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  '<div data-search-nav><button id="previous">Previous</button></div><input id="find">',
);
Object.assign(globalThis, {
  HTMLElement: dom.window.HTMLElement,
});

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

  test("keeps mouse navigation in the find panel so arrow clicks complete", () => {
    const navigation = dom.window.document.querySelector("[data-search-nav]")!;
    const previous = dom.window.document.getElementById("previous")!;
    const findInput = dom.window.document.getElementById("find")!;
    let prevented = false;

    expect(
      preserveFileFindNavigationFocus({
        composedPath: () => [previous, navigation],
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as MouseEvent),
    ).toBe(true);
    expect(prevented).toBe(true);

    expect(
      preserveFileFindNavigationFocus({
        composedPath: () => [findInput],
        preventDefault: () => {
          throw new Error(
            "find input mouse-down must keep its native behavior",
          );
        },
      } as unknown as MouseEvent),
    ).toBe(false);
  });
});
