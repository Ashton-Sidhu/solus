import { describe, expect, test } from 'bun:test'
import { renderDiagramSvg } from '@solus/contracts/diagram-svg'

describe('diagram SVG export', () => {
  test('renders a stable light-theme architecture image', () => {
    const svg = renderDiagramSvg({
      nodes: [
        { id: 'web', label: 'Web <Client>' },
        { id: 'api', label: 'API', fields: [{ name: 'id', type: 'uuid' }] },
      ],
      edges: [{ id: 'request', source: 'web', target: 'api', label: 'HTTPS' }],
    })

    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('Web &lt;Client&gt;')
    expect(svg).toContain('HTTPS')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).not.toContain('<script')
    expect(renderDiagramSvg({
      nodes: [
        { id: 'web', label: 'Web <Client>' },
        { id: 'api', label: 'API', fields: [{ name: 'id', type: 'uuid' }] },
      ],
      edges: [{ id: 'request', source: 'web', target: 'api', label: 'HTTPS' }],
    })).toBe(svg)
  })

  test('rejects an unsafe color value and handles an empty diagram', () => {
    const unsafe = renderDiagramSvg({ nodes: [{ id: 'x', label: 'X', color: 'url(https://example.com/a)' }], edges: [] })
    expect(unsafe).not.toContain('url(https://')
    expect(unsafe).toContain('#b85c3d')
    expect(renderDiagramSvg({ nodes: [], edges: [] })).toContain('Empty diagram')
  })
})
