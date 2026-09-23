import Image from '@tiptap/extension-image'

/** Marked's block-extension fallback can split a standalone image at `![`.
 * Recognize that block before the custom embed/fence tokenizers run. */
export const DocumentImage = Image.extend({
  markdownTokenizer: {
    name: 'image',
    level: 'block',
    start: src => src.indexOf('!['),
    tokenize(src) {
      const match = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)[ \t]*(?:\n|$)/.exec(src)
      if (!match) return undefined
      return { type: 'image', raw: match[0], text: match[1], href: match[2], title: match[3] ?? null }
    },
  },
})
