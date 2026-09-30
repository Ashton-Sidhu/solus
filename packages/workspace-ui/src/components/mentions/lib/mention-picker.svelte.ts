import type { OrganizationPeople } from '../../users/lib/organization-people'
import type { PersonMention } from '@solus/contracts/mentions'
import type { ReferenceToken } from '../../editor/reference-tokens'
import { isSelectable, type MenuItem, type MenuRow, type SelectableRow } from '../../editor/unified-autocomplete/rows'
import { mentionCandidates, mentionQuery } from './mentions'
import { mentionRows } from './mention-rows'

/** What the picker needs from the editor it sits on: CodeMirror or Tiptap. */
export interface MentionEditor {
  textBeforeCursor(): string
  cursorRect(): DOMRect | null
  insertReference(token: ReferenceToken, pattern: RegExp): boolean
  focus(): void
}

/** Who `@` can name, and what naming them writes: an organization member or a code-host account. */
export interface MentionSource {
  /** The `@` query the caret is in, or null when it is in none. */
  query(textBeforeCursor: string): string | null
  rows(query: string): MenuRow[]
  /** Loads the people on the first `@`, not on every keystroke. */
  warm(): void
  /** Writes the item over the `@query`; returns true when it wrote. */
  insert(item: MenuItem, editor: MentionEditor): boolean
}

export interface MentionPickerDeps {
  source: MentionSource
  editor: () => MentionEditor | null
}

export interface OrganizationMentionDeps {
  /** The record organization's directory; null when there is no one to mention. */
  directory: () => OrganizationPeople | null
  recentUserIds: () => readonly string[]
  warm: () => void
  onMention?: (mention: PersonMention) => void
}

/** `@` names a member of the record's organization and writes the person token. */
export function organizationMentionSource(deps: OrganizationMentionDeps): MentionSource {
  return {
    query: mentionQuery,
    rows(query) {
      const directory = deps.directory()
      const candidates = mentionCandidates(directory, deps.recentUserIds(), query)
      // A spaced query that names no one hands the words back to the sentence.
      if (candidates.length === 0 && /\s/.test(query)) return []
      return mentionRows(candidates, query, !!directory && directory.members.length > 0)
    },
    warm: deps.warm,
    insert(item, editor) {
      if (item.token.kind !== 'person') return false
      const { kind: _kind, ...mention } = item.token
      if (!editor.insertReference(item.token, /@[^@\n]*$/)) return false
      deps.onMention?.(mention)
      return true
    },
  }
}

/** Hover selects, except right after a navigation key. */
const HOVER_SUPPRESSION_MS = 400

/**
 * The `@` people picker for a comment or a work body. The editor text is the
 * source of truth: the query is re-read from the caret on each change, so undo
 * and caret moves need no state here. Accepting a row writes the source's token.
 */
export class MentionPicker {
  #textBeforeCursor = $state('')
  #dismissed = $state(false)
  #selectedIndex = $state(0)
  #warmed = false
  #lastKeyAt = 0
  anchorRect = $state<DOMRect | null>(null)

  constructor(private deps: MentionPickerDeps) {}

  query = $derived.by(() => this.deps.source.query(this.#textBeforeCursor))

  rows = $derived.by((): MenuRow[] => {
    const query = this.query
    return query === null ? [] : this.deps.source.rows(query)
  })

  selectableRows = $derived(this.rows.filter(isSelectable))
  selectedIndex = $derived(Math.min(this.#selectedIndex, Math.max(0, this.selectableRows.length - 1)))
  open = $derived(!this.#dismissed && this.rows.length > 0)

  handleEditorChange(textBeforeCursor: string): void {
    const wasOpen = this.deps.source.query(this.#textBeforeCursor) !== null
    this.#textBeforeCursor = textBeforeCursor
    const isOpen = this.deps.source.query(textBeforeCursor) !== null
    if (!isOpen) {
      this.#warmed = false
      return
    }
    if (!wasOpen) {
      this.#dismissed = false
      this.#selectedIndex = 0
    }
    if (!this.#warmed) {
      this.#warmed = true
      this.deps.source.warm()
    }
    this.anchorRect = this.deps.editor()?.cursorRect() ?? null
  }

  activate = (row: SelectableRow): void => {
    const editor = this.deps.editor()
    if (row.type !== 'item' || !editor || !this.deps.source.insert(row.item, editor)) {
      this.dismiss()
      return
    }
    this.#textBeforeCursor = ''
    editor.focus()
  }

  hoverRow = (index: number): void => {
    if (Date.now() - this.#lastKeyAt < HOVER_SUPPRESSION_MS) return
    this.#selectedIndex = index
  }

  dismiss = (): void => {
    this.#dismissed = true
  }

  /** Returns true when the picker used the key; the host must then not act on it. */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.open) return false
    const rows = this.selectableRows
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (rows.length === 0) return false
        this.#lastKeyAt = Date.now()
        const step = event.key === 'ArrowDown' ? 1 : rows.length - 1
        this.#selectedIndex = (this.selectedIndex + step) % rows.length
        break
      }
      case 'Enter':
      case 'Tab': {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
        const row = rows[this.selectedIndex]
        if (!row) return false
        this.activate(row)
        break
      }
      case 'Escape':
        this.dismiss()
        break
      default:
        return false
    }
    event.preventDefault()
    event.stopPropagation()
    return true
  }
}

/** The CodeMirror comment editor's own verbs, as the picker names them. */
export function plainTextMentionEditor(editor: {
  textBeforeCursor(): string
  getCursorRect(): DOMRect | null
  insertReference(token: ReferenceToken, pattern: RegExp): boolean
  focusAtSelection(): void
}): MentionEditor {
  return {
    textBeforeCursor: () => editor.textBeforeCursor(),
    cursorRect: () => editor.getCursorRect(),
    insertReference: (token, pattern) => editor.insertReference(token, pattern),
    focus: () => editor.focusAtSelection(),
  }
}
