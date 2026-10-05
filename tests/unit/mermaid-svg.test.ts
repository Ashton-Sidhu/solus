import { describe, expect, test } from 'bun:test'
import { renderMermaidSVG } from 'beautiful-mermaid'
import {
  NATIVE_DIAGRAM_OPTIONS,
  drawsNatively,
  scopeDiagramSvg,
} from '../../packages/workspace-ui/src/components/conversation/lib/mermaid-svg'

const FLOWCHART = 'flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]'
const CHART = 'xychart-beta\n  x-axis [a, b, c]\n  bar [1, 2, 3]'

function drawn(source: string, idPrefix: string): string {
  return scopeDiagramSvg(renderMermaidSVG(source, NATIVE_DIAGRAM_OPTIONS), idPrefix)
}

describe('which renderer draws a diagram', () => {
  test('the diagram types beautiful-mermaid parses go to it', () => {
    // WHY: these are drawn in a worker in milliseconds; sending them to Mermaid
    // puts half a second of layout back on the main thread.
    for (const header of ['flowchart LR', 'graph TD', 'stateDiagram-v2', 'sequenceDiagram', 'classDiagram', 'erDiagram', 'xychart-beta']) {
      expect(drawsNatively(`%% A comment\n\n${header}\n  A --> B`)).toBe(true)
    }
  })

  test('everything else stays with Mermaid', () => {
    // WHY: beautiful-mermaid reads an unknown header as a flowchart. A gantt or
    // a configured diagram must reach the renderer that understands it, not be
    // drawn wrong.
    for (const source of ['gantt\n  title Plan', 'pie\n  "a": 1', 'mindmap\n  root', 'flowchart\n  A --> B', '---\ntitle: X\n---\nflowchart LR\n  A --> B', '%%{init: {"theme": "dark"}}%%\nflowchart LR\n  A --> B', '']) {
      expect(drawsNatively(source)).toBe(false)
    }
  })
})

describe('a beautiful-mermaid SVG placed inline in the workspace', () => {
  test('fetches nothing from the network', () => {
    // WHY: the library imports its font from Google Fonts. Inline, every diagram
    // would call a third party — and fail offline.
    for (const source of [FLOWCHART, CHART, 'classDiagram\n  Animal <|-- Duck', 'erDiagram\n  A ||--o{ B : has']) {
      expect(drawn(source, 'd1')).not.toContain('@import')
      expect(drawn(source, 'd1')).not.toContain('https://')
    }
  })

  test('styles only itself', () => {
    // WHY: its rules are written for a standalone file — bare `text` and `svg`
    // selectors. Unscoped, they restyle every icon and SVG in the workspace.
    for (const source of [FLOWCHART, CHART]) {
      const styles = [...drawn(source, 'd1').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1])
      expect(styles.length).toBeGreaterThan(0)
      for (const css of styles) {
        expect(css.trimStart().startsWith('@scope {')).toBe(true)
        expect(css).not.toMatch(/(^|[\s,}])svg\s*\{/)
      }
    }
  })

  test('two diagrams on one page never share an id', () => {
    // WHY: arrowheads are markers referenced by id. A shared id resolves to the
    // first diagram in the document; when that one sits in a hidden tab, every
    // other diagram loses its arrows.
    const first = drawn(FLOWCHART, 'solus-diagram-1')
    const second = drawn(FLOWCHART, 'solus-diagram-2')
    const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
    expect(ids(first).length).toBeGreaterThan(0)
    expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([])
    // Every reference still lands on a marker in its own diagram.
    for (const reference of first.matchAll(/="url\(#([^)]+)\)"/g)) {
      expect(ids(first)).toContain(reference[1])
    }
  })

  test('labels are left as written', () => {
    // WHY: the id rewrite must touch attributes, not text a reader wrote.
    const svg = drawn('flowchart LR\n  A["see url(#top) and id=x"] --> B', 'd1')
    expect(svg).toContain('url(#top)')
  })
})
