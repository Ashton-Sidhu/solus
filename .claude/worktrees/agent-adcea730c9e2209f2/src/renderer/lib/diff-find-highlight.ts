import type { DiffFindMatch } from './diff-state.svelte'

// Global registered highlight names. They must match the ::highlight() rules in
// DIFF_FIND_HIGHLIGHT_CSS (diffTheme.ts), which ride into each diff shadow root
// via the CodeView `unsafeCSS` option.
const ALL_HIGHLIGHT = 'solus-diff-find'
const ACTIVE_HIGHLIGHT = 'solus-diff-find-active'

/**
 * The CSS Custom Highlight API is the only way to paint character spans across
 * pierre's virtualized, shadow-rooted diff content without patching its
 * internals. Engines without it (older WebKit) degrade gracefully: the find
 * counter + navigation still work, only the span paint is skipped.
 */
export const CSS_HIGHLIGHT_SUPPORTED =
  typeof CSS !== 'undefined' &&
  'highlights' in CSS &&
  typeof Highlight !== 'undefined' &&
  typeof Range !== 'undefined'

// `CSS.highlights` is document-global and keyed by name, but split panes can
// mount more than one DiffStream at once. Share a single pair of Highlight
// objects across all instances (ref-counted registration) and let whichever
// instance last painted matches "own" the visible ranges — only one find bar is
// ever focused at a time, so the owner is the panel the user is searching in.
let registrationCount = 0
let allHighlight: Highlight | null = null
let activeHighlight: Highlight | null = null
let owner: DiffFindHighlighter | null = null

function acquireHighlights(): void {
  if (!CSS_HIGHLIGHT_SUPPORTED) return
  if (registrationCount === 0) {
    allHighlight = new Highlight()
    activeHighlight = new Highlight()
    CSS.highlights.set(ALL_HIGHLIGHT, allHighlight)
    CSS.highlights.set(ACTIVE_HIGHLIGHT, activeHighlight)
  }
  registrationCount++
}

function releaseHighlights(): void {
  if (!CSS_HIGHLIGHT_SUPPORTED) return
  registrationCount = Math.max(0, registrationCount - 1)
  if (registrationCount === 0) {
    allHighlight?.clear()
    activeHighlight?.clear()
    CSS.highlights.delete(ALL_HIGHLIGHT)
    CSS.highlights.delete(ACTIVE_HIGHLIGHT)
    allHighlight = null
    activeHighlight = null
    owner = null
  }
}

interface RenderedHost {
  id: string
  element: HTMLElement
}

function sameMatch(a: DiffFindMatch | null, b: DiffFindMatch | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.path === b.path &&
    a.side === b.side &&
    a.lineNo === b.lineNo &&
    a.matchStart === b.matchStart
  )
}

// Resolve the line element for a match inside a host's shadow root. Split mode
// has dedicated columns per side; unified packs both into [data-unified], where
// an old line N (deletion) and a new line N (addition) can collide — so we
// disambiguate with data-line-type (only pure deletions are "change-deletion").
function resolveLineEl(
  shadow: ShadowRoot,
  match: DiffFindMatch,
  diffStyle: 'unified' | 'split',
): HTMLElement | null {
  const sideCol = match.side === 'old' ? '[data-deletions]' : '[data-additions]'
  if (diffStyle === 'split') {
    const col = shadow.querySelector(sideCol) ?? shadow.querySelector('[data-unified]')
    return (
      (col?.querySelector(`[data-content] [data-line="${match.lineNo}"]`) as HTMLElement | null) ??
      null
    )
  }
  const col = shadow.querySelector('[data-unified]') ?? shadow.querySelector(sideCol)
  if (!col) return null
  const candidates = col.querySelectorAll(`[data-content] [data-line="${match.lineNo}"]`)
  for (const el of candidates) {
    const isDeletion = el.getAttribute('data-line-type') === 'change-deletion'
    if (match.side === 'old' ? isDeletion : !isDeletion) return el as HTMLElement
  }
  return (candidates[0] as HTMLElement | undefined) ?? null
}

// Map a (matchStart, matchLength) character span onto a DOM Range by walking the
// line's text nodes and accumulating their lengths — the text-node lengths are
// authoritative (a single match can straddle several tokenized <span>s). Returns
// null when offsets fall outside the rendered text (stale/cross-recycle state).
function buildRange(
  shadow: ShadowRoot,
  match: DiffFindMatch,
  diffStyle: 'unified' | 'split',
): Range | null {
  const lineEl = resolveLineEl(shadow, match, diffStyle)
  if (!lineEl) return null

  const start = match.matchStart
  const end = match.matchStart + match.matchLength
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)

  let acc = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.data.length
    if (startNode === null && start < acc + len) {
      startNode = node
      startOffset = start - acc
    }
    if (end <= acc + len) {
      endNode = node
      endOffset = end - acc
      break
    }
    acc += len
    node = walker.nextNode() as Text | null
  }

  if (!startNode || !endNode) return null
  try {
    const range = new Range()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
  } catch {
    return null
  }
}

/**
 * Owns the find highlights for one DiffStream. `repaint` rebuilds ranges from
 * the currently rendered (visible, non-collapsed) hosts; off-screen matches are
 * counted by the panel and become paintable once scrolled/expanded into view.
 */
export class DiffFindHighlighter {
  private matchesByPath = new Map<string, DiffFindMatch[]>()
  private activeMatch: DiffFindMatch | null = null

  constructor() {
    acquireHighlights()
  }

  setMatches(matches: DiffFindMatch[]): void {
    const byPath = new Map<string, DiffFindMatch[]>()
    for (const m of matches) {
      const arr = byPath.get(m.path)
      if (arr) arr.push(m)
      else byPath.set(m.path, [m])
    }
    this.matchesByPath = byPath
  }

  setActive(match: DiffFindMatch | null): void {
    this.activeMatch = match
  }

  repaint(renderedItems: RenderedHost[], diffStyle: 'unified' | 'split'): void {
    if (!CSS_HIGHLIGHT_SUPPORTED || !allHighlight || !activeHighlight) return
    // Background/other-pane streams have no matches: don't touch the shared
    // highlights so they can't wipe the panel the user is actually searching in.
    if (this.matchesByPath.size === 0 && owner !== this) return

    owner = this
    allHighlight.clear()
    activeHighlight.clear()

    for (const host of renderedItems) {
      const matches = this.matchesByPath.get(host.id)
      if (!matches || matches.length === 0) continue
      const shadow = host.element.shadowRoot
      if (!shadow) continue
      for (const match of matches) {
        const range = buildRange(shadow, match, diffStyle)
        if (!range) continue
        if (sameMatch(match, this.activeMatch)) activeHighlight.add(range)
        else allHighlight.add(range)
      }
    }
  }

  clear(): void {
    this.matchesByPath = new Map()
    this.activeMatch = null
    if (owner === this) {
      allHighlight?.clear()
      activeHighlight?.clear()
      owner = null
    }
  }

  destroy(): void {
    this.clear()
    releaseHighlights()
  }
}
