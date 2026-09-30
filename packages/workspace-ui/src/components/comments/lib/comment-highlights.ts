import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { PlanComment } from '@solus/contracts/types'
import { textBetweenIdxToPos } from '../../plan/lib/comments'

/**
 * Local comment threads, highlighted as decorations.
 *
 * A highlight is what this client shows, not what the document holds: it
 * never enters the document's JSON, its markdown, or its undo history, and a
 * shared document never carries one reader's threads. External (Google,
 * Confluence) threads have their own plugin in `work/lib`; the two never
 * share state.
 *
 * Each highlight is a `<mark data-plan-comment>` element, the element the rail
 * measures, hovers, and flashes.
 */

/** A thread's state, which its highlight wears: amber is a human thread, sage a
 *  resolved one, dashed terracotta one Solus wrote. The styles live in the
 *  workspace stylesheet. Every state stays legible with the rail hidden. */
type HighlightType = 'saved' | 'resolved' | 'solus'

const HIGHLIGHT_CLASS = {
  saved: 'plan-comment-saved',
  resolved: 'plan-comment-resolved',
  solus: 'plan-comment-solus',
} satisfies { [Type in HighlightType]: string }

/** The part of a thread its highlight is drawn from. */
export interface CommentAnchor {
  commentId: string
  /** The selected text, found again in the document after a reload. */
  quote: string
  /** Offset of the quote in the flattened text, to prefer the nearest match. */
  textOffset: number
  type: HighlightType
}

interface HighlightState {
  anchors: CommentAnchor[]
  decorations: DecorationSet
}

type HighlightChange =
  | { kind: 'show'; anchors: CommentAnchor[] }
  | { kind: 'add'; anchor: CommentAnchor; from: number; to: number }
  | { kind: 'remove'; commentId: string }

export const commentHighlightsKey = new PluginKey<HighlightState>('commentHighlights')

export function highlightTypeFor(comment: PlanComment): HighlightType {
  if (comment.resolvedAt) return 'resolved'
  if (comment.author && comment.author.kind !== 'user') return 'solus'
  return 'saved'
}

export function commentAnchor(comment: PlanComment): CommentAnchor {
  return {
    commentId: comment.id,
    quote: comment.selectedText,
    textOffset: comment.textOffset ?? 0,
    type: highlightTypeFor(comment),
  }
}

function highlight(from: number, to: number, anchor: CommentAnchor): Decoration {
  return Decoration.inline(from, to, {
    nodeName: 'mark',
    class: HIGHLIGHT_CLASS[anchor.type],
    'data-plan-comment': anchor.commentId,
    'data-comment-type': anchor.type,
  }, { commentId: anchor.commentId, type: anchor.type })
}

/** The quote's range in the document: the match nearest its saved offset, or
 *  the first match. Blocks are joined by one space in the searched text. */
function quoteRange(doc: ProseMirrorNode, anchor: CommentAnchor): { from: number; to: number } | null {
  if (!anchor.quote) return null
  const text = doc.textBetween(0, doc.content.size, ' ')
  let index = text.indexOf(anchor.quote, Math.max(0, anchor.textOffset - 50))
  if (index === -1) index = text.indexOf(anchor.quote)
  if (index === -1) return null
  const from = textBetweenIdxToPos(doc, index)
  const to = textBetweenIdxToPos(doc, index + anchor.quote.length)
  return from !== -1 && to > from ? { from, to } : null
}

/**
 * Highlights for `anchors`. A thread that already has a highlight keeps its
 * range, mapped through every edit since, so a refresh cannot move it back to
 * an old quote. Only a thread without one is found by its quote.
 */
function place(doc: ProseMirrorNode, anchors: CommentAnchor[], current: DecorationSet): DecorationSet {
  const ranges = new Map<string, Decoration>()
  for (const decoration of current.find()) ranges.set(decoration.spec.commentId, decoration)
  const decorations: Decoration[] = []
  for (const anchor of anchors) {
    const existing = ranges.get(anchor.commentId)
    const range = existing ?? quoteRange(doc, anchor)
    if (!range) continue
    decorations.push(existing?.spec.type === anchor.type ? existing : highlight(range.from, range.to, anchor))
  }
  return DecorationSet.create(doc, decorations)
}

function nextState(transaction: Transaction, previous: HighlightState): HighlightState {
  const change: HighlightChange | undefined = transaction.getMeta(commentHighlightsKey)
  // A whole-document replacement (a reload, an agent's rewrite) maps every
  // range to nothing, so each thread is found by its quote in the new text.
  const replaced = transaction.docChanged && transaction.getMeta('preventUpdate') === true
  const mapped = replaced
    ? DecorationSet.empty
    : transaction.docChanged ? previous.decorations.map(transaction.mapping, transaction.doc) : previous.decorations
  if (!change) {
    if (replaced) return { anchors: previous.anchors, decorations: place(transaction.doc, previous.anchors, mapped) }
    return mapped === previous.decorations ? previous : { anchors: previous.anchors, decorations: mapped }
  }
  if (change.kind === 'show') {
    return { anchors: change.anchors, decorations: place(transaction.doc, change.anchors, mapped) }
  }
  const others = previous.anchors.filter((anchor) => anchor.commentId !== (change.kind === 'add' ? change.anchor.commentId : change.commentId))
  const kept = mapped.find().filter((decoration) => others.some((anchor) => anchor.commentId === decoration.spec.commentId))
  if (change.kind === 'remove') return { anchors: others, decorations: DecorationSet.create(transaction.doc, kept) }
  return {
    anchors: [...others, change.anchor],
    decorations: DecorationSet.create(transaction.doc, [...kept, highlight(change.from, change.to, change.anchor)]),
  }
}

export function commentHighlightPlugin() {
  return new Plugin<HighlightState>({
    key: commentHighlightsKey,
    state: {
      init: () => ({ anchors: [], decorations: DecorationSet.empty }),
      apply: nextState,
    },
    props: {
      // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
      decorations: (state) => commentHighlightsKey.getState(state)?.decorations,
    },
  })
}

export const CommentHighlights = Extension.create({
  name: 'commentHighlights',
  addProseMirrorPlugins: () => [commentHighlightPlugin()],
})

/** The transaction that applies a highlight change: view state only, so it is
 *  never an undo step and never marks the document dirty. */
export function commentHighlightTransaction(state: EditorState, change: HighlightChange): Transaction {
  return state.tr.setMeta(commentHighlightsKey, change).setMeta('addToHistory', false)
}

function dispatchChange(editor: Editor, change: HighlightChange): void {
  if (editor.isDestroyed || !commentHighlightsKey.getState(editor.state)) return
  editor.view.dispatch(commentHighlightTransaction(editor.state, change))
}

function sameAnchors(left: CommentAnchor[], right: CommentAnchor[]): boolean {
  return left.length === right.length && left.every((anchor, index) => {
    const other = right[index]
    return anchor.commentId === other.commentId && anchor.quote === other.quote
      && anchor.textOffset === other.textOffset && anchor.type === other.type
  })
}

/** Highlight exactly these threads. A thread left out loses its highlight. */
export function showCommentHighlights(editor: Editor, comments: PlanComment[]): void {
  const anchors = comments.map(commentAnchor)
  const previous = editor.isDestroyed ? undefined : commentHighlightsKey.getState(editor.state)
  if (!previous || sameAnchors(previous.anchors, anchors)) return
  dispatchChange(editor, { kind: 'show', anchors })
}

/** Highlight a new thread over the exact selection it was written on. */
export function addCommentHighlight(editor: Editor, from: number, to: number, comment: PlanComment): void {
  dispatchChange(editor, { kind: 'add', anchor: commentAnchor(comment), from, to })
}

export function removeCommentHighlight(editor: Editor, commentId: string): void {
  dispatchChange(editor, { kind: 'remove', commentId })
}

/**
 * Document position of each highlighted thread — what the outline needs to say
 * which section a thread belongs to. Read from the plugin rather than from the
 * DOM, so it survives a heading being scrolled out of view.
 */
export function commentHighlightPositions(editor: Editor | null): { id: string; pos: number }[] {
  // Tiptap clears its state during destroy. A measurement queued with `tick`
  // can still run during that teardown, so reject the stale editor first.
  if (!editor || editor.isDestroyed) return []
  const decorations = commentHighlightsKey.getState(editor.state)?.decorations.find() ?? []
  const seen = new Set<string>()
  const positions: { id: string; pos: number }[] = []
  for (const decoration of [...decorations].sort((left, right) => left.from - right.from)) {
    const id = String(decoration.spec.commentId)
    if (seen.has(id)) continue
    seen.add(id)
    positions.push({ id, pos: decoration.from })
  }
  return positions
}
