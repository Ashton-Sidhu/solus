import { Extension, type Editor } from '@tiptap/core'
import '@tiptap/starter-kit'
import '@tiptap/extension-table'
import '@tiptap/extension-task-list'
import type { Component } from 'svelte'
import {
  TextTIcon,
  TextHOneIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  ListChecksIcon,
  QuotesIcon,
  CodeIcon,
  TableIcon,
  MinusIcon,
} from 'phosphor-svelte'

export interface EditorBlockCommand {
  id: string
  label: string
  description: string
  keywords: string[]
  icon: Component
  group: string
  action: (editor: Editor) => void
}

export const EDITOR_BLOCK_COMMANDS: EditorBlockCommand[] = [
  {
    id: 'paragraph',
    label: 'Text',
    description: 'Plain paragraph',
    keywords: ['paragraph', 'plain'],
    icon: TextTIcon,
    group: 'basic',
    action: (e) => { e.chain().focus().setParagraph().run() },
  },
  {
    id: 'heading1',
    label: 'Heading 1',
    description: 'Large section heading',
    keywords: ['h1', 'title', 'large'],
    icon: TextHOneIcon,
    group: 'heading',
    action: (e) => { e.chain().focus().setHeading({ level: 1 }).run() },
  },
  {
    id: 'heading2',
    label: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['h2', 'subtitle'],
    icon: TextHTwoIcon,
    group: 'heading',
    action: (e) => { e.chain().focus().setHeading({ level: 2 }).run() },
  },
  {
    id: 'heading3',
    label: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3', 'small'],
    icon: TextHThreeIcon,
    group: 'heading',
    action: (e) => { e.chain().focus().setHeading({ level: 3 }).run() },
  },
  {
    id: 'bulletList',
    label: 'Bullet List',
    description: 'Unordered list',
    keywords: ['ul', 'unordered', 'bullets'],
    icon: ListBulletsIcon,
    group: 'list',
    action: (e) => { e.chain().focus().toggleBulletList().run() },
  },
  {
    id: 'orderedList',
    label: 'Numbered List',
    description: 'Ordered list',
    keywords: ['ol', 'ordered', 'numbers'],
    icon: ListNumbersIcon,
    group: 'list',
    action: (e) => { e.chain().focus().toggleOrderedList().run() },
  },
  {
    id: 'taskList',
    label: 'Task List',
    description: 'Checklist items',
    keywords: ['todo', 'checkbox', 'checklist'],
    icon: ListChecksIcon,
    group: 'list',
    action: (e) => { e.chain().focus().toggleTaskList().run() },
  },
  {
    id: 'blockquote',
    label: 'Quote',
    description: 'Blockquote',
    keywords: ['blockquote', 'citation', 'pullquote'],
    icon: QuotesIcon,
    group: 'advanced',
    action: (e) => { e.chain().focus().toggleBlockquote().run() },
  },
  {
    id: 'codeBlock',
    label: 'Code Block',
    description: 'Syntax-highlighted code',
    keywords: ['code', 'pre', 'snippet', 'syntax'],
    icon: CodeIcon,
    group: 'advanced',
    action: (e) => { e.chain().focus().toggleCodeBlock().run() },
  },
  {
    id: 'table',
    label: 'Table',
    description: 'Insert a table',
    keywords: ['grid', 'spreadsheet', 'columns'],
    icon: TableIcon,
    group: 'advanced',
    action: (e) => { e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Horizontal rule',
    keywords: ['hr', 'line', 'separator', 'break'],
    icon: MinusIcon,
    group: 'advanced',
    action: (e) => { e.chain().focus().setHorizontalRule().run() },
  },
]

export function filterCommands(query: string): EditorBlockCommand[] {
  const q = query.toLowerCase().trim()
  if (!q) return EDITOR_BLOCK_COMMANDS
  return EDITOR_BLOCK_COMMANDS.filter(cmd =>
    cmd.label.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    cmd.keywords.some(k => k.includes(q))
  )
}

export function executeSlashCommand(editor: Editor, cmd: EditorBlockCommand, from: number, to: number) {
  editor.chain().focus().deleteRange({ from, to }).run()
  cmd.action(editor)
}

export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addStorage() {
    return {
      onArrowDown: null as (() => boolean) | null,
      onArrowUp: null as (() => boolean) | null,
      onEnter: null as (() => boolean) | null,
      onEscape: null as (() => boolean) | null,
    }
  },

  addKeyboardShortcuts() {
    return {
      ArrowDown: () => this.storage.onArrowDown?.() ?? false,
      ArrowUp: () => this.storage.onArrowUp?.() ?? false,
      Tab: () => this.storage.onArrowDown?.() ?? false,
      'Shift-Tab': () => this.storage.onArrowUp?.() ?? false,
      Enter: () => this.storage.onEnter?.() ?? false,
      Escape: () => this.storage.onEscape?.() ?? false,
    }
  },
})
