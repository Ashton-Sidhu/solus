import { afterEach, describe, expect, test } from "bun:test";
import { sql, SQLite } from "@codemirror/lang-sql";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div id=\"editor\"></div>", {
  pretendToBeVisual: true,
});

Object.assign(globalThis, {
  window: dom.window,
  Window: dom.window.Window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "<div id=\"editor\"></div>";
});

describe("CodeMirror dependency graph", () => {
  test("language extensions and editors use one View package", () => {
    const lockfile = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");

    // CodeMirror ViewPlugin and Facet values are tied to their package instance.
    // A nested View copy lets SQL parse but prevents its highlight decorations
    // from rendering in the editor created by the root View package.
    expect(lockfile).not.toMatch(/"@codemirror\/[^"]+\/@codemirror\/view"/);
  });

  test("SQL language tags render as highlight spans", () => {
    const highlight = HighlightStyle.define([
      { tag: tags.keyword, color: "var(--solus-accent)" },
      { tag: tags.number, color: "var(--solus-art-5)" },
    ]);
    const parent = document.querySelector<HTMLElement>("#editor");
    if (!parent) throw new Error("CodeMirror test host is missing");

    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "select * from turns where duration_ms > 1000",
        extensions: [sql({ dialect: SQLite }), syntaxHighlighting(highlight)],
      }),
    });

    const highlightedTokens = [
      ...document.querySelectorAll(".cm-content span"),
    ].map((element) => element.textContent);

    expect(highlightedTokens).toEqual(["select", "from", "where", "1000"]);
  });
});
