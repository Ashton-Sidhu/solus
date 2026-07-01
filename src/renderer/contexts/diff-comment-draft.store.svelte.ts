import { createContext } from 'svelte'

/** A selected line range being commented on, in one diff side's coordinates. */
export interface DraftRange {
  startLine: number
  endLine: number
  side: 'old' | 'new'
}

/**
 * The in-progress inline-comment draft for a diff surface: which range/file is
 * selected, whether it's editing an existing comment, and the unsaved text.
 *
 * One instance per diff surface — split panes each own theirs. The Diff tab
 * (DiffPanel) shares its instance down to DiffStream via context; the PR-review
 * guide (GuideFileDiff) instantiates one per file card. Transition logic — when
 * a re-selection keeps already-typed text, when to persist — stays in each
 * surface because they differ, so this only owns the state and its derived label.
 */
export class InlineCommentDraft {
  /** Selected range, or null when no draft is open. */
  range = $state<DraftRange | null>(null)
  /** File the draft targets. Single-file surfaces leave this null. */
  filePath = $state<string | null>(null)
  /** Set when editing an existing comment rather than authoring a new one. */
  editingCommentId = $state<string | null>(null)
  /** Unsaved comment text, preserved across range adjustments within one draft. */
  value = $state('')

  /** "L12" / "L12–L18" label for the form header, or undefined when idle. */
  get rangeLabel(): string | undefined {
    const r = this.range
    if (!r) return undefined
    return r.startLine === r.endLine
      ? `L${r.startLine}`
      : `L${r.startLine}–L${r.endLine}`
  }

  /** Drop the draft back to idle. Surface-specific side effects (clearing the
   *  diff component's selection, the persisted sidecar) stay with the caller. */
  clear(): void {
    this.range = null
    this.filePath = null
    this.editingCommentId = null
    this.value = ''
  }
}

export const [getInlineCommentDraft, setInlineCommentDraft] =
  createContext<InlineCommentDraft>()
