import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'

// Pele needs no browser: without a canvas it measures labels with its own font
// metrics. The DOM is here for the element the diagram mounts into and for the
// sanitizer.
test('a Mermaid diagram mounts sanitized, reports what does not parse, and draws again when fixed', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="diagram"></div></body></html>')
  const globals = ['window', 'document', 'getComputedStyle'] as const
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) })
  // No canvas: Pele falls back to its own font metrics.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null
  try {
    const { loadDiagramRenderer, mermaidDiagram } = await import('../../packages/workspace-ui/src/components/conversation/lib/mermaid-block')
    const pele = await loadDiagramRenderer('flowchart LR\n A --> B')
    if (!pele) throw new Error('Pele did not load')
    // The type's chunk is in, so the diagram draws synchronously on mount.
    expect(pele.registered('flowchart')).toBe(true)

    const element = dom.window.document.getElementById('diagram') as HTMLElement
    const events: string[] = []
    const params = {
      pele,
      source: 'flowchart LR\n A[Start] --> B[End]',
      onRender: () => events.push('render'),
      onError: (message: string) => events.push(`error: ${message}`),
    }
    const action = mermaidDiagram(element, params)
    expect(events).toEqual(['render'])
    const svg = element.querySelector('svg')
    expect(svg?.getAttribute('class')).toBe('pele pele-flowchart')
    // The SVG holds no palette: its colours are variables that the `.pele`
    // rules in workspace.css set, so a theme change needs no new render.
    expect(svg?.getAttribute('style')).toContain('var(--pele-bg')
    expect(element.textContent).toContain('Start')

    // A diagram from an untrusted body draws with no link or remote resource.
    action?.update?.({ ...params, source: 'flowchart LR\n A --> B\n click A href "https://example.com"' })
    expect(element.querySelector('a, image, foreignObject, style, [href]')).toBeNull()

    action?.update?.({ ...params, source: 'flowchart LR\n A -->' })
    expect(events.at(-1)).toBe("error: Parse error on line 2: Expecting 'NODE_STRING', got 'EOF'")

    // The block hides the diagram while its text does not parse, so the
    // element has no width; the fixed text must still draw.
    element.hidden = true
    action?.update?.({ ...params, source: 'flowchart LR\n A --> C' })
    expect(events.at(-1)).toBe('render')
    action?.destroy?.()
  } finally {
    dom.window.close()
    globals.forEach((name, index) => {
      const descriptor = previous[index]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})

test('a source of no known type still gets the renderer, whose parser says why', async () => {
  const { loadDiagramRenderer } = await import('../../packages/workspace-ui/src/components/conversation/lib/mermaid-block')
  const pele = await loadDiagramRenderer('broken')
  expect(pele).not.toBeNull()
  expect(() => pele?.parse('broken')).toThrow('No diagram type detected')
})
