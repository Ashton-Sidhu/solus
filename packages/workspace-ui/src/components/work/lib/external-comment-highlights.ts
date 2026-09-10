import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { WorkExternalComments } from '@solus/contracts/work-comments'
import { googleQuoteRange } from './google-comment-quote'

interface HighlightQuote { threadId: string; quote: string }
interface HighlightInput { target: string; quotes: HighlightQuote[] }
interface HighlightState extends HighlightInput { decorations: DecorationSet }

export const externalHighlightsKey = new PluginKey<HighlightState>('externalCommentHighlights')

/** View-only annotations: never enter markdown, history, or published content. */
export function externalCommentHighlightPlugin() {
  return new Plugin<HighlightState>({
    key: externalHighlightsKey,
    state: {
      init: () => ({ target: '', quotes: [], decorations: DecorationSet.empty }),
      apply(transaction, previous) {
        const replaced = transaction.docChanged && transaction.getMeta('preventUpdate') === true
        const input: HighlightInput | undefined = transaction.getMeta(externalHighlightsKey) ?? (replaced ? previous : undefined)
        if (!input && !transaction.docChanged) return previous
        const mapped = previous.decorations.map(transaction.mapping, transaction.doc)
        if (!input) return { ...previous, decorations: mapped }
        const sameTarget = !replaced && input.target === previous.target
        const priorQuotes = new Map(previous.quotes.map(item => [item.threadId, item.quote]))
        const priorRanges = new Map(mapped.find().map(range => [range.spec.threadId, range]))
        const decorations: Decoration[] = []
        for (const item of input.quotes) {
          if (sameTarget && priorQuotes.get(item.threadId) === item.quote) {
            // A refresh must not restore an old quote over a range edited locally.
            const range = priorRanges.get(item.threadId)
            if (range) decorations.push(range)
            continue
          }
          const range = googleQuoteRange(transaction.doc, item.quote)
          if (range) decorations.push(Decoration.inline(range.from, range.to, {
            class: 'external-comment-highlight',
            'data-external-comment': item.threadId,
          }, { threadId: item.threadId }))
        }
        return { ...input, decorations: DecorationSet.create(transaction.doc, decorations) }
      },
    },
    props: {
      // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
      decorations: state => externalHighlightsKey.getState(state)?.decorations,
    },
  })
}

export const ExternalCommentHighlights = Extension.create({
  name: 'externalCommentHighlights',
  addProseMirrorPlugins: () => [externalCommentHighlightPlugin()],
})

export function externalHighlightInput(snapshot?: WorkExternalComments, workId?: string): HighlightInput {
  return snapshot
    ? {
      target: JSON.stringify([workId, snapshot.provider, snapshot.externalKey, snapshot.documentId]),
      quotes: snapshot.threads.filter(thread => !thread.deleted && !thread.resolved && thread.textAnchor?.attachmentState !== 'detached' && thread.textAnchor?.quote)
        .map(thread => ({ threadId: thread.id, quote: thread.textAnchor!.quote })),
    }
    : { target: '', quotes: [] }
}

export function updateExternalCommentHighlights(editor: Editor, snapshot?: WorkExternalComments, workId?: string): void {
  const input = externalHighlightInput(snapshot, workId)
  const previous = externalHighlightsKey.getState(editor.state)
  if (!previous || (previous.target === input.target && JSON.stringify(previous.quotes) === JSON.stringify(input.quotes))) return
  editor.view.dispatch(editor.state.tr.setMeta(externalHighlightsKey, input).setMeta('addToHistory', false))
}

export function externalCommentRange(editor: Editor, threadId: string): { from: number; to: number } | undefined {
  const range = externalHighlightsKey.getState(editor.state)?.decorations.find().find(item => item.spec.threadId === threadId)
  return range ? { from: range.from, to: range.to } : undefined
}
