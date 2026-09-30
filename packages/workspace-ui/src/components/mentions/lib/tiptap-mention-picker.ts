import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import * as references from '../../editor/references'
import type { MentionEditor, MentionPicker } from './mention-picker.svelte'

/**
 * Wires the people picker into a Tiptap work body: every change re-reads the
 * caret, and the picker's keys (arrows, Enter, Tab, Escape) are taken before
 * the editor's own keymaps while the picker is open.
 */
export function createMentionPickerExtension(picker: MentionPicker) {
  return Extension.create({
    name: 'mentionPicker',
    // Ahead of StarterKit's Enter and list keymaps, which would split the line.
    priority: 1000,
    onUpdate() {
      picker.handleEditorChange(references.textBeforeCursor(this.editor))
    },
    onSelectionUpdate() {
      picker.handleEditorChange(references.textBeforeCursor(this.editor))
    },
    addProseMirrorPlugins() {
      return [new Plugin({ props: { handleKeyDown: (_view, event) => picker.handleKeyDown(event) } })]
    },
  })
}

export function tiptapMentionEditor(editor: Editor): MentionEditor {
  return {
    textBeforeCursor: () => references.textBeforeCursor(editor),
    cursorRect: () => {
      const caret = editor.view.coordsAtPos(editor.state.selection.from)
      return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top)
    },
    insertReference: (token, pattern) => references.insertReference(editor, token, pattern),
    focus: () => {
      editor.commands.focus()
    },
  }
}
