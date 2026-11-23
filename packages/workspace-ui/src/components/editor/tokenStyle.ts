import { githubOcticonPaths } from '@solus/client-core/github-octicons'

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
  | 'task'
  | 'automation'
  | 'file'
  | 'slash'
  | 'person'
  | 'host'

export function tokenClassName(variant: TokenVariant, mono = false): string {
  return `solus-token solus-token--${variant}${mono ? ' solus-token--mono' : ''}`
}

/*
 * Tiptap's `renderHTML` returns arrays for markup and SVG icons.
 *
 * ProseMirror creates elements via `createElement` by default (no SVG
 * namespace), so we use the `"<namespace> <tag>"` DOMOutputSpec convention to
 * force `createElementNS`. The namespace propagates to all descendant elements
 * within the same renderSpec call.
 */
const SVG_NS = 'http://www.w3.org/2000/svg'

export type SvgSpec = [string, Record<string, string>, ...(string | SvgSpec)[]]
export type IconArray = SvgSpec

const SVG_ATTRS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2.2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

export const TOKEN_ICONS = {
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
  pr: [`${SVG_NS} svg`, { viewBox: '-1.6 -1.6 19.2 19.2', fill: 'currentColor' },
    ['path', { d: githubOcticonPaths.pullRequest }],
  ],
  task: [`${SVG_NS} svg`, { viewBox: '-1.6 -1.6 19.2 19.2', fill: 'currentColor' },
    ['path', { d: githubOcticonPaths.issueOpened }],
  ],
  // workflow
  automation: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['rect', { width: '8', height: '8', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M7 11v4a2 2 0 0 0 2 2h4' }],
    ['rect', { width: '8', height: '8', x: '13', y: '13', rx: '2' }],
  ],
  // at-sign
  person: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8' }],
  ],
  // server
  host: [`${SVG_NS} svg`, { ...SVG_ATTRS },
    ['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }],
    ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }],
    ['path', { d: 'M6 6h.01' }],
    ['path', { d: 'M6 18h.01' }],
  ],
} satisfies Record<'plan' | 'planAccepted' | 'planRejected' | 'work' | 'pr' | 'session' | 'task' | 'automation' | 'person' | 'host', IconArray>
