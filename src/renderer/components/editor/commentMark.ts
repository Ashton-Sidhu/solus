import { Mark, mergeAttributes } from '@tiptap/core'

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
        class: HTMLAttributes.type === 'active' ? 'plan-comment-active' : 'plan-comment-saved',
      }),
      0,
    ]
  },
})
