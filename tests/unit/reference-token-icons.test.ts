import { afterEach, describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { serializeReferenceToken } from "../../src/renderer/components/editor/reference-tokens";
import { createReferenceDecorations } from "../../src/renderer/components/ui/plain-text-editor/lib/reference-decorations";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const dom = new JSDOM("<div id=\"editor\"></div>");
const requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(callback, 0);

Object.assign(dom.window, {
  requestAnimationFrame,
  cancelAnimationFrame: clearTimeout,
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame,
  cancelAnimationFrame: clearTimeout,
});

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "<div id=\"editor\"></div>";
});

describe("composer reference token icons", () => {
  test("creates Works icon paths in the SVG namespace", () => {
    // WHY: HTML-namespace <path> elements inside the SVG silently render no
    // glyph, leaving a blank gap before the Works title in the input bar.
    const source = serializeReferenceToken({
      kind: "work",
      workId: "work-1",
      title: "Design spec",
      type: "doc",
    });
    const references = createReferenceDecorations(() => ({}));

    view = new EditorView({
      parent: document.querySelector("#editor") as HTMLElement,
      state: EditorState.create({
        doc: source,
        extensions: references.extension,
      }),
    });

    const paths = [
      ...document.querySelectorAll(".solus-token--work svg path"),
    ];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.namespaceURI === SVG_NAMESPACE)).toBe(
      true,
    );
  });
});
