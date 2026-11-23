import { afterEach, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { createReferenceDecorations } from "@solus/workspace-ui/components/ui/plain-text-editor/lib/reference-decorations";

const dom = new JSDOM("<div id=\"editor\"></div>");
const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
Object.assign(dom.window, { requestAnimationFrame, cancelAnimationFrame: clearTimeout });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame,
  cancelAnimationFrame: clearTimeout,
});

const DOC = "see @src/app.ts and [#12 Fix it](pr://?number=12&title=Fix%20it) now";
let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "<div id=\"editor\"></div>";
});

function mountComposer(): EditorView {
  const references = createReferenceDecorations(() => ({ onFileRefClick: () => {} }));
  view = new EditorView({
    parent: document.querySelector("#editor") as HTMLElement,
    state: EditorState.create({ doc: DOC, extensions: references.extension }),
  });
  return view;
}

function press(chip: Element, detail: number): void {
  chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail }));
  chip.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail }));
}

function selectedText(editor: EditorView): string {
  const { from, to } = editor.state.selection.main;
  return editor.state.sliceDoc(from, to);
}

test("a double-click on a composer chip selects the reference it stands for", () => {
  // WHY: CodeMirror ignores events on a widget, so a double-click on a chip
  // selected nothing. A chip is a word of the prompt: it selects whole, and the
  // copy is the reference itself, which pastes back as the same chip.
  const editor = mountComposer();
  const [file, pr] = document.querySelectorAll(".solus-token");
  press(file, 2);
  expect(selectedText(editor)).toBe("@src/app.ts");
  press(pr, 2);
  expect(selectedText(editor)).toBe("[#12 Fix it](pr://?number=12&title=Fix%20it)");
});

test("a click on a chip that opens nothing puts the caret beside it", () => {
  // WHY: without a target to open, a click on the chip is a click in the text.
  const editor = mountComposer();
  const pr = document.querySelector(".solus-token--pr")!;
  press(pr, 1);
  const { from, to } = editor.state.selection.main;
  expect(from).toBe(to);
  const chipStart = DOC.indexOf("[#12");
  expect([chipStart, chipStart + "[#12 Fix it](pr://?number=12&title=Fix%20it)".length]).toContain(from);
});

test("a chip inside the selection paints the highlight itself", () => {
  // WHY: the selection layer is measured from text and leaves a chip out, so
  // a selected chip looked unselected. The chip carries the selected class
  // while it is inside the selection, and loses it when it is not.
  const editor = mountComposer();
  editor.dispatch({ selection: { anchor: 0, head: DOC.indexOf(" and") } });
  expect(document.querySelector(".solus-token--file")?.classList.contains("solus-token--selected")).toBe(true);
  expect(document.querySelector(".solus-token--pr")?.classList.contains("solus-token--selected")).toBe(false);
  editor.dispatch({ selection: { anchor: 0 } });
  expect(document.querySelectorAll(".solus-token--selected").length).toBe(0);
});

test("a file chip with a line opens its file at the line", () => {
  // WHY: a file copied from a reply keeps its line (`@src/foo.ts:12`). The
  // chip's path holds the line; the file pane needs them apart.
  const opened: [string, number | undefined][] = [];
  const references = createReferenceDecorations(() => ({ onFileRefClick: (path, line) => opened.push([path, line]) }));
  view = new EditorView({
    parent: document.querySelector("#editor") as HTMLElement,
    state: EditorState.create({ doc: "see @src/foo.ts:12 now", extensions: references.extension }),
  });
  (document.querySelector(".solus-token--file") as HTMLElement).click();
  expect(opened).toEqual([["src/foo.ts", 12]]);
});
