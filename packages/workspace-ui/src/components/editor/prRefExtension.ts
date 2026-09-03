import { createReferenceNode } from './lib/reference-node'
import { TOKEN_ICONS } from './tokenStyle'

export interface PrRefAttrs {
  number: number
  title: string
}

export const PrRefExtension = createReferenceNode<PrRefAttrs>({
  name: 'prReference',
  scheme: 'pr',
  dataAttr: 'data-pr-ref',
  attrs: {
    number: { default: null },
    title: { default: '' },
  },
  // The link text carries `#N ` ahead of the title; the chip re-adds it.
  fromUrl: (url, label) => {
    const number = Number(url.searchParams.get('number'))
    return { number, title: label.replace(new RegExp(`^#${number}\\s*`), '') }
  },
  toToken: (attrs) => ({ kind: 'pr', number: attrs.number ?? 0, title: attrs.title ?? '' }),
  idOf: (attrs) => attrs.number,
  label: (attrs) => `#${attrs.number} ${attrs.title}`,
  variant: () => 'pr',
  icon: () => TOKEN_ICONS.pr,
})
