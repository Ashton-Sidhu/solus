import { afterEach, describe, expect, test } from "bun:test";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { richTextInput } from "@solus/workspace-ui/components/ui/plain-text-editor/lib/rich-text-input";
import { JSDOM } from "jsdom";
import { createReferenceDecorations } from "@solus/workspace-ui/components/ui/plain-text-editor/lib/reference-decorations";
import {
  referencesAsDocumentHtml,
  restoreReferences,
} from "@solus/workspace-ui/components/editor/reference-clipboard";

const dom = new JSDOM("<div id=\"editor\"></div>");
const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
Object.assign(dom.window, { requestAnimationFrame, cancelAnimationFrame: clearTimeout });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  DOMParser: dom.window.DOMParser,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame,
  cancelAnimationFrame: clearTimeout,
});

const PR = "[#12 Fix it](pr://ref?number=12)";
const AUTOMATION = "[Daily digest](automation://ref?automationId=a1)";
const PROMPT = `see @src/app.ts and ${PR}\nthen ${AUTOMATION}`;

let views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  document.body.innerHTML = "<div id=\"editor\"></div>";
});

function mountComposer(
  doc: string,
  onLinkRefClick?: (href: string, title: string) => void,
  onPaste?: Parameters<typeof richTextInput>[2],
): EditorView {
  const references = createReferenceDecorations(() => ({ onLinkRefClick }));
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [Prec.highest(richTextInput(() => true, () => ({}), onPaste ?? (() => {}), () => {})), references.extension] }) });
  views.push(view);
  return view;
}

/** A clipboard event as the browser sends it; jsdom has no DataTransfer. */
function clipboardEvent(type: "copy" | "cut" | "paste", data: Map<string, string>): Event {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (kind: string) => data.get(kind) ?? "", setData: (kind: string, value: string) => data.set(kind, value) },
  });
  return event;
}

describe("a composer's copy", () => {
  test("reads as text, and pastes back into a composer as the same chips", () => {
    // WHY: a copied file is its path and an automation its name, wherever it is
    // pasted; a paste into a composer must still give the chips back.
    const source = mountComposer(PROMPT);
    source.dispatch({ selection: { anchor: 0, head: PROMPT.length } });
    const clipboard = new Map<string, string>();
    source.contentDOM.dispatchEvent(clipboardEvent("copy", clipboard));
    expect(clipboard.get("text/plain")).toBe("see src/app.ts and #12 Fix it\nthen Daily digest");

    const target = mountComposer("");
    target.contentDOM.dispatchEvent(clipboardEvent("paste", clipboard));
    expect(target.state.doc.toString()).toBe(PROMPT);
  });

  test("a cut removes what it copied", () => {
    const source = mountComposer(PROMPT);
    source.dispatch({ selection: { anchor: 0, head: PROMPT.indexOf("\n") } });
    const clipboard = new Map<string, string>();
    source.contentDOM.dispatchEvent(clipboardEvent("cut", clipboard));
    expect(clipboard.get("text/plain")).toBe("see src/app.ts and #12 Fix it");
    expect(source.state.doc.toString()).toBe(`\nthen ${AUTOMATION}`);
  });
});

describe("a chip copied from a message", () => {
  // The markup a reply's chips copy as: readable text, the reference beside it.
  const html = [
    'see <button class="solus-token solus-token--file" data-solus-reference="@src/app.ts:12">',
    '<span class="solus-token__icon"><svg><title>ts</title></svg></span>',
    '<span><span class="solus-token__copy-only">src/</span><span>app.ts<span>:12</span></span></span></button>',
    ' and <button class="solus-token" data-solus-reference="[Daily digest](automation://ref?automationId=a1)"><span>Daily digest</span></button>',
    ' or <button data-solus-reference="@config/app.json"><span class="solus-token__copy-only">config/app.json</span><span class="solus-token__shown-only">the config</span></button>',
  ].join("");
  const plain = "see src/app.ts:12 and Daily digest or config/app.json";

  test("pastes into a composer as the same chips", () => {
    expect(restoreReferences(plain, html)).toBe(`see @src/app.ts:12 and ${AUTOMATION} or @config/app.json`);
  });

  test("a reference the composer does not read stays text", () => {
    // WHY: a comment box reads `@name` as prose, so a file stays its path.
    expect(restoreReferences(plain, html, { kinds: new Set(["automation"]) })).toBe(
      `see src/app.ts:12 and ${AUTOMATION} or config/app.json`,
    );
  });

  test("a copy with no chips is left to the ordinary paste", () => {
    expect(restoreReferences("plain words", "<p>plain words</p>")).toBeNull();
  });

  test("pastes into a document as the markup its own chips parse", () => {
    const pasted = new DOMParser().parseFromString(referencesAsDocumentHtml(html), "text/html").body;
    expect(pasted.querySelector("span[data-file-ref]")?.getAttribute("path")).toBe("src/app.ts:12");
    expect(pasted.querySelector('a[href^="automation://"]')?.textContent).toBe("Daily digest");
    expect(pasted.querySelector("button")).toBeNull();
  });
});

test("a session, task, automation, or host chip in the composer opens what it names", () => {
  // WHY: the same chip opens its target in a message. In the composer it did
  // nothing, so a click there read as broken.
  const opened: [string, string][] = [];
  mountComposer(`run ${AUTOMATION}`, (href, title) => opened.push([href, title]));
  (document.querySelector(".solus-token--automation") as HTMLElement).click();
  expect(opened).toEqual([["automation://ref?automationId=a1", "Daily digest"]]);
});

test("pastes an external anchor beside a copied chip with the same label", () => {
  const target = mountComposer("");
  const clipboard = new Map([
    ["text/plain", "src/app.ts and src/app.ts"],
    ["text/html", '<a href="https://example.com/setup">src/app.ts</a> and <span data-solus-reference="@src/app.ts">src/app.ts</span>'],
  ]);
  target.contentDOM.dispatchEvent(clipboardEvent("paste", clipboard));
  expect(target.state.doc.toString()).toBe("[src/app.ts](https://example.com/setup) and @src/app.ts");
});

test("Paste as Text and pasting into code insert the literal label", () => {
  const clipboard = new Map([
    ["text/plain", "Guide"],
    ["text/html", '<a href="https://example.com/setup">Guide</a>'],
  ]);
  const plain = mountComposer("before ");
  plain.dispatch({ selection: { anchor: 7 } });
  plain.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "V", shiftKey: true, ctrlKey: true, bubbles: true,
  }));
  plain.contentDOM.dispatchEvent(clipboardEvent("paste", clipboard));
  expect(plain.state.doc.toString()).toBe("before Guide");

  const code = mountComposer("```\n\n```");
  code.dispatch({ selection: { anchor: 4 } });
  code.contentDOM.dispatchEvent(clipboardEvent("paste", clipboard));
  expect(code.state.doc.toString()).toBe("```\nGuide\n```");
});

test("lets the attachment handler consume a paste after it sees restored Markdown", () => {
  const target = mountComposer("", undefined, (event, paste) => {
    expect(paste.text).toBe("[Guide](https://example.com/setup)");
    event.preventDefault();
  });
  target.contentDOM.dispatchEvent(clipboardEvent("paste", new Map([
    ["text/plain", "Guide"],
    ["text/html", '<a href="https://example.com/setup">Guide</a>'],
  ])));
  expect(target.state.doc.toString()).toBe("");
});

test("inserts rich text at the drop position instead of the selected text", () => {
  const view = mountComposer("Read the docs");
  const event = new dom.window.MouseEvent("drop", { bubbles: true, cancelable: true });
  const clipboard = new Map([
    ["text/plain", "Guide"],
    ["text/html", '<a href="https://example.com/setup">Guide</a>'],
  ]);
  Object.defineProperty(event, "dataTransfer", {
    value: { getData: (kind: string) => clipboard.get(kind) ?? "", files: [] },
  });
  view.posAtCoords = () => 5;
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(view.state.doc.toString()).toBe("Read [Guide](https://example.com/setup)the docs");
});
