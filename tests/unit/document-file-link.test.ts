import { describe, expect, mock, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { documentExtensions } from "@solus/document-model/schema";
import { parseDocumentMarkdown, serializeDocumentMarkdown } from "@solus/document-model/markdown";

mock.module("../../packages/workspace-ui/src/lib/inputFocus", () => ({ requestInputFocus() {} }));
const { fileLinkDecorations } = await import("../../packages/workspace-ui/src/components/editor/fileLinkExtension");

const schema = getSchema(documentExtensions());
const docOf = (markdown: string) => schema.nodeFromJSON(parseDocumentMarkdown(markdown));

describe("file-path links in a document", () => {
  test("a link to a file shows as a file chip and a web link does not", () => {
    // WHY: a path is a file on the host, not a web page. It must look like the
    // file chip the conversation shows, so a reader knows a click opens the file.
    const markdown = "See [ledger](/Users/me/plans/ledger.json), [a.ts:12](src/a.ts:12) and [site](https://example.com).";
    const doc = docOf(markdown);
    const chips = fileLinkDecorations(doc).find().map((d) => doc.textBetween(d.from, d.to));
    expect(chips).toEqual(["ledger", "a.ts:12"]);
    // The chip is a view only: the saved markdown keeps the plain links.
    expect(serializeDocumentMarkdown(doc.toJSON())).toBe(markdown);
  });

  test("decorating a large work stays cheap", () => {
    // WHY: the set is rebuilt on every edit, so it must stay well under a frame
    // for a work the size of a 446-row review table.
    const rows = Array.from({ length: 450 }, (_, i) =>
      `| #${i} | Ready | Some text about the change | [a.ts:${i}](/repo/a.ts:${i})<br>[b.tsx:${i}](/repo/b.tsx:${i}) |`);
    const doc = docOf(`| PR | State | Notes | Where |\n| --- | --- | --- | --- |\n${rows.join("\n")}`);
    const start = performance.now();
    const set = fileLinkDecorations(doc);
    const elapsed = performance.now() - start;
    expect(set.find().length).toBe(900);
    expect(elapsed).toBeLessThan(16);
  });
});
