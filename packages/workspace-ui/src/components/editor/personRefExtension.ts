import { mergeAttributes } from '@tiptap/core'
import { PersonReference } from '@solus/document-model/person-reference'
import { tokenClassName, TOKEN_ICONS } from './tokenStyle'
import { mentionLabel, type PersonStanding } from '../mentions/lib/mentions'

export interface PersonRefAttrs {
  userId: string
  /** The name saved with the mention. */
  name: string
}

/**
 * A mention of an organization member in a work body. The node, its
 * attributes, and its markdown are the document model's; this adds the chip,
 * which shows the member's current name. A person who left the organization
 * is the saved name as plain text, with no chip. `standing` is read when the
 * node renders.
 */
export function createPersonRefExtension(standing: (userId: string) => PersonStanding) {
  return PersonReference.extend({
    renderHTML({ node, HTMLAttributes }) {
      // SAFETY: this node's schema is PersonRefAttrs; both parse paths and the
      // picker's insert write the whole shape.
      const attrs = node.attrs as PersonRefAttrs
      const current = standing(attrs.userId)
      const label = mentionLabel(attrs, current)
      if (current.kind === 'left') {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-person-ref': attrs.userId, contenteditable: 'false', class: 'solus-mention-left' }), label]
      }
      return [
        'span',
        mergeAttributes(HTMLAttributes, { 'data-person-ref': attrs.userId, contenteditable: 'false', class: tokenClassName('person') }),
        ['span', { class: 'solus-token__icon' }, TOKEN_ICONS.person],
        ['span', {}, label],
      ]
    },
  })
}
