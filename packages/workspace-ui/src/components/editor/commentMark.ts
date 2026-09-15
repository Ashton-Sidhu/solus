import { Mark, mergeAttributes } from '@tiptap/core'

/** Annotation state → mark class. Each state has to stay legible with the
 *  thread hidden, because that is what split view does to the comments rail:
 *  amber is a human thread, sage a resolved one, dashed terracotta an edit
 *  Solus made, red a conflict. The styles live in index.css. */
const MARK_CLASS = {
  saved: 'plan-comment-saved',
  active: 'plan-comment-active',
  resolved: 'plan-comment-resolved',
  solus: 'plan-comment-solus',
  conflict: 'plan-comment-conflict',
} satisfies Record<string, string>

export const CommentMark = Mark.create({
  name: 'planComment',

  // Each attribute reads back the data attribute it renders. ProseMirror
  // re-parses a mark from its own DOM whenever something outside the editor
  // touches that DOM — the rail toggling the active or flash class on a
  // highlight is exactly that — and the default parser looks for an attribute
  // named `commentId`, which is never there. A highlight that re-parses
  // without its id is a thread the rail can no longer find in the text.
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-plan-comment'),
      },
      type: {
        default: 'saved',
        parseHTML: (element) => element.getAttribute('data-comment-type') ?? 'saved',
      },
    }
  },

  addStorage() {
    return {
      markdown: {
        serialize: { open: '', close: '' },
        parse: {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'mark[data-plan-comment]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'mark',
      mergeAttributes({
        'data-plan-comment': HTMLAttributes.commentId,
        'data-comment-type': HTMLAttributes.type,
        class: MARK_CLASS[HTMLAttributes.type] ?? MARK_CLASS.saved,
      }),
      0,
    ]
  },
})
