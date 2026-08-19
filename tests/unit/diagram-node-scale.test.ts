import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readDiagramSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../src/renderer/components/diagram', path), 'utf8')

const shellCss = readDiagramSource('DiagramShell.css')
const nodeSource = readDiagramSource('nodes/DiagramNode.svelte')
const groupSource = readDiagramSource('nodes/DiagramGroupNode.svelte')
const graphLayout = readDiagramSource('lib/graph-layout.ts')

describe('diagram node display scale', () => {
  test('the shell owns one card rung, compact on a laptop display', () => {
    // WHY: a card is drawn in canvas pixels, so it does not shrink with the
    // window — the laptop rung is the only thing that keeps it proportional to
    // the screen it is read on. Coarse-pointer clients keep the full size, the
    // same exception `--text-workspace-chrome` makes.
    expect(shellCss).toContain('--diagram-node-scale: 1;')
    expect(shellCss).toMatch(
      /@media \(pointer: fine\)\s*{\s*html\.is-laptop-display \.diagram-shell\s*{\s*--diagram-node-scale: 0\.875;/,
    )
  })

  test('the card scales as a unit — box, padding and type together', () => {
    // WHY: this task began because the card's type moved rungs while its box
    // did not. Scaling either one alone re-opens that gap.
    expect(nodeSource).toContain('--node-scale: var(--diagram-node-scale, 1);')
    expect(nodeSource).toContain('min-width: calc(12.5rem * var(--node-scale));')
    expect(nodeSource).toContain('max-width: calc(18rem * var(--node-scale));')
    expect(nodeSource).toContain(
      'padding: calc(0.5625rem * var(--node-scale)) var(--node-pad-x) var(--node-pad-bottom);',
    )
    expect(nodeSource).toContain('--node-title-size: calc(var(--text-caption) * var(--node-scale));')
    expect(nodeSource).toContain('--node-meta-size: calc(var(--text-footnote) * var(--node-scale));')
    // No card type may sit on an unscaled rung any more.
    expect(nodeSource).not.toMatch(/font-size: var\(--text-(caption|footnote)\);/)
  })

  test('the entity field table tracks the card padding it bleeds out of', () => {
    // WHY: the negative margins mirror the card's padding. Hard-coded copies
    // would tear the field wash away from the card edge on the laptop rung.
    expect(nodeSource).toContain('calc(-1 * var(--node-pad-x))')
    expect(nodeSource).toContain('calc(-1 * var(--node-pad-bottom))')
    expect(nodeSource).toContain('padding: calc(0.21875rem * var(--node-scale)) var(--node-pad-x);')
  })

  test('a group scales its header chip but never its frame', () => {
    // WHY: the frame is document geometry (GROUP_W/GROUP_H or a resized value);
    // only the chip is chrome, and it has to stay level with the card titles.
    expect(groupSource).toContain('--group-scale: var(--diagram-node-scale, 1);')
    expect(groupSource).toContain('font-size: calc(var(--text-caption) * var(--group-scale));')
    expect(groupSource).toContain('min-width: 13.75rem;')
    expect(groupSource).toContain('min-height: 8.75rem;')
  })

  test('document geometry stays display-independent', () => {
    // WHY: layout estimates and resize bounds are written into the diagram. A
    // display-dependent value there would make the same document open at a
    // different size on the next machine, and drift every time it is saved.
    expect(graphLayout).toContain('export const NODE_WIDTH_EST = 200;')
    expect(graphLayout).toContain('export const GROUP_W = 320;')
    expect(nodeSource).toContain('minWidth={200}')
    expect(nodeSource).toContain('maxWidth={288}')
  })
})
