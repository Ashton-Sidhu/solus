import type { Editor } from "@tiptap/core";
import type { MarkdownStorage } from "tiptap-markdown";

export function getMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: MarkdownStorage }
  ).markdown.getMarkdown();
}
