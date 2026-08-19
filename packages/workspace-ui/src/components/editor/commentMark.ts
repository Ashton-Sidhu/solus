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

  addAttributes() {
    return {
      commentId: { default: null },
      type: { default: 'saved' },
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
