// Turns a pointer position inside a @pierre/diffs render into the identifier
// under it. Both the diff stream and the file editor draw code the same way —
// one `[data-line]` content cell per line inside a shadow root — so one
// resolver serves both surfaces.

import type { CodeSymbolAvailability } from './symbol-card'

/** Word characters as the indexers see them; `$` for JavaScript. */
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u
/** A minified line is not a navigation target, and measuring it is not free. */
const MAX_LINE_CHARS = 2_000
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 8
const HOVER_INTENT_MS = 100
const HOVER_HIGHLIGHT_NAME = 'solus-code-symbol'

/** Injected into each code surface's shadow root. The highlight uses a DOM
 *  range, so the renderer does not need extra token wrappers. */
export const CODE_SYMBOL_HOVER_CSS = `
::highlight(${HOVER_HIGHLIGHT_NAME}) {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.15em;
  color: var(--solus-accent);
}
`

export interface CodeSymbolHit {
  /** 1-based, as the surface numbers its lines. */
  line: number
  side: 'old' | 'new'
  /** 0-based UTF-16 offset of the identifier's first character. */
  character: number
  token: string
  /** Where the identifier is painted; the card anchors to it. */
  anchor: DOMRect
  /** The `[data-line]` cell the hit landed in, so the caller can find its file. */
  lineElement: HTMLElement
  /** The identifier's text, for the hover underline. */
  range: Range
}

interface TextRun {
  node: Text
  start: number
}

interface LineText {
  runs: TextRun[]
  text: string
}

function lineElementFrom(event: Event): HTMLElement | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue
    if (node.hasAttribute('data-line') && !node.hasAttribute('data-column-number')) return node
  }
  return null
}

function sideOf(lineElement: HTMLElement): 'old' | 'new' {
  if (lineElement.closest('[data-deletions]')) return 'old'
  if (lineElement.closest('[data-additions]')) return 'new'
  return lineElement.getAttribute('data-line-type') === 'change-deletion' ? 'old' : 'new'
}

function textRunsOf(lineElement: HTMLElement): LineText {
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT)
  const runs: TextRun[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || node.data.length === 0) continue
    runs.push({ node, start: text.length })
    text += node.data
    if (text.length > MAX_LINE_CHARS) break
  }
  return { runs, text }
}

function rectContains(rect: DOMRect, x: number, y: number): boolean {
  return rect.left <= x && x < rect.right && rect.top <= y && y <= rect.bottom
}

interface CharacterAtPoint {
  character: number
  rect: DOMRect
}

/** The character painted at (x, y), or null when the point is in the gutter,
 *  past the end of the line, or between wrapped rows. */
function characterAtPoint(runs: TextRun[], x: number, y: number): CharacterAtPoint | null {
  const range = document.createRange()
  for (const run of runs) {
    range.selectNodeContents(run.node)
    let inRun = false
    for (const rect of range.getClientRects()) {
      if (rectContains(rect, x, y)) {
        inRun = true
        break
      }
    }
    if (!inRun) continue
    for (let index = 0; index < run.node.data.length; index++) {
      range.setStart(run.node, index)
      range.setEnd(run.node, index + 1)
      const rect = range.getBoundingClientRect()
      if (rectContains(rect, x, y)) return { character: run.start + index, rect }
    }
  }
  return null
}

function positionOf(runs: TextRun[], character: number): { node: Text; offset: number } | null {
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    if (character >= run.start) return { node: run.node, offset: character - run.start }
  }
  return null
}

function identifierAround(text: string, character: number): { start: number; end: number } | null {
  if (!IDENTIFIER_CHAR.test(text[character] ?? '')) return null
  let start = character
  let end = character + 1
  while (start > 0 && IDENTIFIER_CHAR.test(text[start - 1]!)) start--
  while (end < text.length && IDENTIFIER_CHAR.test(text[end]!)) end++
  return { start, end }
}

type CodeSymbolLocation = { hit: CodeSymbolHit; miss: null } | { hit: null; miss: DOMRect | null }

function locateCodeSymbol(lineElement: HTMLElement, x: number, y: number): CodeSymbolLocation {
  const line = Number(lineElement.getAttribute('data-line'))
  if (!Number.isFinite(line)) return { hit: null, miss: null }
  const { runs, text } = textRunsOf(lineElement)
  if (runs.length === 0) return { hit: null, miss: null }
  const at = characterAtPoint(runs, x, y)
  if (!at) return { hit: null, miss: null }
  const identifier = identifierAround(text, at.character)
  if (!identifier) return { hit: null, miss: at.rect }
  const from = positionOf(runs, identifier.start)
  const to = positionOf(runs, identifier.end)
  if (!from || !to) return { hit: null, miss: at.rect }
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return {
    hit: {
      line,
      side: sideOf(lineElement),
      character: identifier.start,
      token: text.slice(identifier.start, identifier.end),
      anchor: range.getBoundingClientRect(),
      lineElement,
      range,
    },
    miss: null,
  }
}

export function resolveCodeSymbolHit(lineElement: HTMLElement, x: number, y: number): CodeSymbolHit | null {
  return locateCodeSymbol(lineElement, x, y).hit
}

/** One registry entry for the whole document. Only the symbol under the active
 *  pointer is highlighted. Older WebKit versions simply omit this affordance. */
function hoverHighlight(): Highlight | null {
  const HighlightConstructor = globalThis.Highlight
  const registry = globalThis.CSS?.highlights
  if (!HighlightConstructor || !registry) return null
  let highlight = registry.get(HOVER_HIGHLIGHT_NAME)
  if (!highlight) {
    highlight = new HighlightConstructor()
    registry.set(HOVER_HIGHLIGHT_NAME, highlight)
  }
  return highlight
}

function isModifierHeld(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey
}

/**
 * Cmd/Ctrl-click (keyboard pointers) or a long press (touch) on an identifier.
 * Plain clicks stay with the surface. A resting pointer underlines only a
 * symbol that SCIP confirms, so the interface shows that it is interactive.
 * The explicit gesture also opens the card when the index has a status to
 * report, so a deliberate click is never a dead end.
 */
interface CodeSymbolGestureOptions {
  onHit: (hit: CodeSymbolHit) => void
  availability: (hit: CodeSymbolHit) => Promise<CodeSymbolAvailability>
}

export function attachCodeSymbolGesture(
  host: HTMLElement,
  { onHit, availability }: CodeSymbolGestureOptions,
): () => void {
  const openIfAnswerable = (hit: CodeSymbolHit) => {
    void availability(hit)
      .then((verdict) => {
        if (verdict !== 'none') onHit(hit)
      })
      .catch(() => undefined)
  }
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let pressOrigin: { x: number; y: number; lineElement: HTMLElement } | null = null
  let suppressClickUntil = 0

  let pointer: { x: number; y: number; lineElement: HTMLElement } | null = null
  let hovered: CodeSymbolHit | null = null
  let pendingHover: CodeSymbolHit | null = null
  let deadZone: { lineElement: HTMLElement; rect: DOMRect } | null = null
  let hoverFrame = 0
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let hoverGeneration = 0

  const clearHover = () => {
    hoverGeneration++
    if (hoverFrame) cancelAnimationFrame(hoverFrame)
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverFrame = 0
    hoverTimer = null
    deadZone = null
    pendingHover = null
    if (!hovered) return
    hoverHighlight()?.delete(hovered.range)
    hovered = null
  }

  const applyHover = () => {
    hoverFrame = 0
    if (!pointer) {
      clearHover()
      return
    }
    const { x, y, lineElement } = pointer
    if (hovered && hovered.lineElement === lineElement && rectContains(hovered.anchor, x, y)) return
    if (pendingHover && pendingHover.lineElement === lineElement && rectContains(pendingHover.anchor, x, y)) return
    if (deadZone && deadZone.lineElement === lineElement && rectContains(deadZone.rect, x, y)) return
    const located = locateCodeSymbol(lineElement, x, y)
    clearHover()
    if (!located.hit) {
      if (located.miss) deadZone = { lineElement, rect: located.miss }
      return
    }
    const candidate = located.hit
    const generation = hoverGeneration
    pendingHover = candidate
    hoverTimer = setTimeout(() => {
      hoverTimer = null
      void availability(candidate)
        .then((verdict) => {
          if (verdict !== 'symbol' || generation !== hoverGeneration || pendingHover !== candidate) return
          const highlight = hoverHighlight()
          if (!highlight) return
          highlight.add(candidate.range)
          hovered = candidate
          pendingHover = null
        })
        .catch(() => {
          if (generation === hoverGeneration) pendingHover = null
        })
    }, HOVER_INTENT_MS)
  }

  const scheduleHover = () => {
    if (!hoverFrame) hoverFrame = requestAnimationFrame(applyHover)
  }

  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = null
    pressOrigin = null
  }

  const onClick = (event: MouseEvent) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!isModifierHeld(event) || event.button !== 0) return
    const lineElement = lineElementFrom(event)
    if (!lineElement) return
    const hit = resolveCodeSymbolHit(lineElement, event.clientX, event.clientY)
    if (!hit) return
    event.preventDefault()
    event.stopPropagation()
    clearHover()
    openIfAnswerable(hit)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (pressOrigin && Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > LONG_PRESS_SLOP_PX) {
      cancelPress()
    }
    if (event.pointerType === 'touch') return
    const lineElement = lineElementFrom(event)
    pointer = lineElement ? { x: event.clientX, y: event.clientY, lineElement } : null
    if (pointer) scheduleHover()
    else clearHover()
  }

  const onPointerLeave = () => {
    pointer = null
    clearHover()
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    const lineElement = lineElementFrom(event)
    if (!lineElement) return
    cancelPress()
    pressOrigin = { x: event.clientX, y: event.clientY, lineElement }
    pressTimer = setTimeout(() => {
      const origin = pressOrigin
      cancelPress()
      if (!origin) return
      const hit = resolveCodeSymbolHit(origin.lineElement, origin.x, origin.y)
      if (!hit) return
      suppressClickUntil = performance.now() + 600
      openIfAnswerable(hit)
    }, LONG_PRESS_MS)
  }

  host.addEventListener('click', onClick, { capture: true })
  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerleave', onPointerLeave)
  host.addEventListener('pointerup', cancelPress)
  host.addEventListener('pointercancel', cancelPress)
  host.addEventListener('scroll', clearHover, { capture: true, passive: true })
  window.addEventListener('blur', clearHover)
  return () => {
    cancelPress()
    clearHover()
    host.removeEventListener('click', onClick, { capture: true })
    host.removeEventListener('pointerdown', onPointerDown)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerleave', onPointerLeave)
    host.removeEventListener('pointerup', cancelPress)
    host.removeEventListener('pointercancel', cancelPress)
    host.removeEventListener('scroll', clearHover, { capture: true })
    window.removeEventListener('blur', clearHover)
  }
}
