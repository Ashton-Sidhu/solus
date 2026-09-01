import type { Editor } from "@tiptap/core";

export function isActive(
  editor: Editor | null,
  _stateVersion: number,
  name: string,
  attrs?: Record<string, unknown>,
): boolean {
  if (!editor) return false;
  return editor.isActive(name, attrs);
}

export function cmd(
  editor: Editor | null,
  action: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>,
): void {
  if (!editor) return;
  action(editor.chain().focus()).run();
}
