import { afterEach, describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { JSDOM } from "jsdom";
import { createMarkdownParser } from "@solus/workspace-ui/components/editor/markdownParser";
import { DiagramEmbedMarkdownExtension } from "@solus/workspace-ui/components/editor/diagramEmbedExtension";
import { serializeDiagramEmbed } from "@solus/contracts/diagram-embed";

const dom = new JSDOM("<div id=\"editor\"></div>");

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
});

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "<div id=\"editor\"></div>";
});

describe("document editor markdown", () => {
  test("preserves explicit line breaks instead of joining adjacent words", () => {
    const markdown = [
      "Morning light drifts in  ",
      "Tea steam curls above the sill  ",
      "Sparrows stitch the dawn",
    ].join("\n");

    // SAFETY: The fixture always creates this element before each test.
    editor = new Editor({
      element: document.querySelector("#editor") as HTMLElement,
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        Markdown.configure({ marked: createMarkdownParser() }),
      ],
      content: markdown,
      contentType: "markdown",
    });

    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Morning light drifts in" },
            { type: "hardBreak" },
            { type: "text", text: "Tea steam curls above the sill" },
            { type: "hardBreak" },
            { type: "text", text: "Sparrows stitch the dawn" },
          ],
        },
      ],
    });
    expect(editor.getMarkdown()).toBe(markdown);
  });

  test("round-trips a diagram embed as a block node", () => {
    const markdown = serializeDiagramEmbed({ workId: "diagram-1", title: "System Architecture" });
    // SAFETY: The fixture always creates this element before each test.
    editor = new Editor({
      element: document.querySelector("#editor") as HTMLElement,
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        Markdown.configure({ marked: createMarkdownParser() }),
        DiagramEmbedMarkdownExtension,
      ],
      content: markdown,
      contentType: "markdown",
    });

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "diagramEmbed",
      attrs: { workId: "diagram-1", title: "System Architecture" },
    });
    expect(editor.getMarkdown()).toBe(markdown);
  });
});
