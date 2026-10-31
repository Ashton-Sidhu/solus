import { afterEach, describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import { getSchema, Node as TiptapNode } from "@tiptap/core";
import { DOMSerializer } from "prosemirror-model";
import { FileRefExtension } from "@solus/workspace-ui/components/editor/fileRefExtension";
import { serializeReferenceToken } from "@solus/workspace-ui/components/editor/reference-tokens";
import { createReferenceDecorations } from "@solus/workspace-ui/components/ui/plain-text-editor/lib/reference-decorations";
import { resolveFileIcon } from "@solus/client-core/file-icons";

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
  test("rich-text file references use the path's icon when the label has no extension", () => {
    const schema = getSchema([
      TiptapNode.create({ name: "doc", topNode: true, content: "inline*" }),
      TiptapNode.create({ name: "text", group: "inline" }),
      FileRefExtension,
    ]);
    const node = schema.nodes.fileReference.create({ path: "docs/AGENTS.md", name: "Instructions" });
    const element = DOMSerializer.fromSchema(schema).serializeNode(node);
    document.body.appendChild(element);
    const expected = document.createElement("span");
    expected.innerHTML = resolveFileIcon("docs/AGENTS.md").svg;
    expect(document.querySelector("[data-file-ref] svg")?.isEqualNode(expected.firstElementChild)).toBe(true);
    expect(element.textContent).toContain("Instructions");
  });

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

  test("draws a folder chip with the folder glyph, not a file glyph", () => {
    // WHY: a folder picked from the @ menu keeps its trailing slash. The chip
    // must show that it is a folder, the same as the menu row and the sent
    // message do.
    const references = createReferenceDecorations(() => ({}));

    view = new EditorView({
      parent: document.querySelector("#editor") as HTMLElement,
      state: EditorState.create({
        doc: "see @/Users/me/project/ and @src/app.ts",
        extensions: references.extension,
      }),
    });

    const [folder, file] = document.querySelectorAll(".solus-token--file .solus-token__icon");
    const expected = document.createElement("span");
    expected.innerHTML = resolveFileIcon("/Users/me/project/").svg;
    expect(folder.firstElementChild?.isEqualNode(expected.firstElementChild)).toBe(true);
    expected.innerHTML = resolveFileIcon("src/app.ts").svg;
    expect(file.firstElementChild?.isEqualNode(expected.firstElementChild)).toBe(true);
    expect([...file.querySelectorAll("path")].every((path) => path.namespaceURI === SVG_NAMESPACE)).toBe(true);
  });
});
