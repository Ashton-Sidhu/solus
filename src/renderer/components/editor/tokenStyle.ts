/*
 * Shared shape for the inline-token Tiptap nodes (plan / file / slash).
 * Variants differ only in icon and color class — the underlying styles
 * (soft wash, padding, radius, hover) live in `.solus-token` in index.css.
 */

export type TokenVariant =
  | 'plan-pending'
  | 'plan-accepted'
  | 'plan-rejected'
  | 'session'
  | 'work'
  | 'pr'
  | 'file'
  | 'slash'

export function tokenClassName(variant: TokenVariant, mono = false): string {
  return `solus-token solus-token--${variant}${mono ? ' solus-token--mono' : ''}`
}

/*
 * Tiptap's `renderHTML` returns vdom-like arrays; SVG icons ship as the same
 * shape. Each icon is a 24×24 stroked glyph styled by the surrounding class.
 *
 * ProseMirror creates elements via `createElement` by default (no SVG
 * namespace), so we use the `"<namespace> <tag>"` DOMOutputSpec convention to
 * force `createElementNS`. The namespace propagates to all descendant elements
 * within the same renderSpec call.
 */
const SVG_NS = 'http://www.w3.org/2000/svg'

type SvgChild = (string | Record<string, string> | SvgChild)[]
type IconArray = [string, Record<string, string>, ...SvgChild[]]

const SVG_ATTRS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2.2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

export const TOKEN_ICONS: Record<'plan' | 'planAccepted' | 'planRejected' | 'work' | 'pr' | 'session', IconArray> = {
  // message-square
  session: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }],
  ],
  // list-checks
  plan: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['path', { d: 'm3 17 2 2 4-4' }],
    ['path', { d: 'm3 7 2 2 4-4' }],
    ['path', { d: 'M13 6h8' }],
    ['path', { d: 'M13 12h8' }],
    ['path', { d: 'M13 18h8' }],
  ],
  // check
  planAccepted: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['path', { d: 'M20 6 9 17l-5-5' }],
  ],
  // x
  planRejected: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  // file-text
  work: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
    ['path', { d: 'M14 2v6h6' }],
    ['path', { d: 'M16 13H8' }],
    ['path', { d: 'M16 17H8' }],
    ['path', { d: 'M10 9H8' }],
  ],
  // git-pull-request
  pr: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['circle', { cx: '6', cy: '6', r: '3' }],
    ['path', { d: 'M6 9v12' }],
    ['circle', { cx: '18', cy: '18', r: '3' }],
    ['path', { d: 'M18 15V8a2 2 0 0 0-2-2h-4' }],
    ['path', { d: 'm15 3-3 3 3 3' }],
  ],
}
