import { Extension, type Editor } from '@tiptap/core'
import '@tiptap/starter-kit'
import '@tiptap/extension-table'
import '@tiptap/extension-task-list'
import type { Component } from 'svelte'
import {
    Type as TextTIcon,
    Heading1 as TextHOneIcon,
    Heading2 as TextHTwoIcon,
    Heading3 as TextHThreeIcon,
    List as ListBulletsIcon,
    ListOrdered as ListNumbersIcon,
    ListChecks as ListChecksIcon,
    Quote as QuotesIcon,
    Code as CodeIcon,
    Table as TableIcon,
    Minus as MinusIcon,
    Sparkles as SparkleIcon,
    Network as ArchitectureIcon,
  } from "@lucide/svelte";export interface EditorBlockCommand {
  id: string
  label: string
  description: string
  keywords: string[]
  icon: Component
  group: string
  /** Rendered in accent — reserved for the one entry that reaches the agent
   *  rather than inserting a block. */
  accent?: boolean
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

/** The agent entry is built per host rather than living in the static list —
 *  it needs a callback, and surfaces without an agent must not offer it. */
export function askSolusCommand(onAskSolus: () => void): EditorBlockCommand {
  return {
    id: 'askSolus',
    label: 'Ask Solus to draft…',
    description: 'Hand this block to the agent',
    keywords: ['ai', 'agent', 'solus', 'draft', 'write', 'generate'],
    icon: SparkleIcon,
    group: 'agent',
    accent: true,
    action: () => onAskSolus(),
  }
}

export function embedDiagramCommand(onEmbedDiagram: () => void): EditorBlockCommand {
  return {
    id: 'diagram',
    label: 'Embed Diagram',
    description: 'Insert a live architecture diagram',
    keywords: ['architecture', 'graph', 'system', 'flow', 'embed'],
    icon: ArchitectureIcon,
    group: 'advanced',
    action: () => onEmbedDiagram(),
  }
}

export function filterCommands(query: string, extra: EditorBlockCommand[] = []): EditorBlockCommand[] {
  const all = extra.length > 0 ? [...EDITOR_BLOCK_COMMANDS, ...extra] : EDITOR_BLOCK_COMMANDS
  const q = query.toLowerCase().trim()
  if (!q) return all
  return all.filter(cmd =>
    cmd.label.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    cmd.keywords.some(k => k.includes(q))
  )
}

/**
 * Whether the block menu is on screen. A "/" token that matches no command
 * shows nothing, so the key handlers must gate on this rather than on the
 * token alone — otherwise an invisible menu eats Enter, Tab, and the arrows
 * while the user types a path or a bare slash.
 */
export function slashMenuIsOpen(tokenActive: boolean, matchCount: number): boolean {
  return tokenActive && matchCount > 0
}

export function executeSlashCommand(editor: Editor, cmd: EditorBlockCommand, from: number, to: number) {
  editor.chain().focus().deleteRange({ from, to }).run()
  cmd.action(editor)
}

interface SlashCommandStorage {
  onArrowDown: (() => boolean) | null
  onArrowUp: (() => boolean) | null
  onEnter: (() => boolean) | null
  onEscape: (() => boolean) | null
}

export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addStorage() {
    const storage: SlashCommandStorage = {
      onArrowDown: null,
      onArrowUp: null,
      onEnter: null,
      onEscape: null,
    }
    return storage
  },

  addKeyboardShortcuts() {
    return {
      ArrowDown: () => this.storage.onArrowDown?.() ?? false,
      ArrowUp: () => this.storage.onArrowUp?.() ?? false,
      Tab: () => this.storage.onEnter?.() ?? false,
      'Shift-Tab': () => this.storage.onArrowUp?.() ?? false,
      Enter: () => this.storage.onEnter?.() ?? false,
      Escape: () => this.storage.onEscape?.() ?? false,
    }
  },
})
