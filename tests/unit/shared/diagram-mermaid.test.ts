import { describe, test, expect } from 'bun:test'
import { serializeMermaid } from '../../../src/shared/diagram-mermaid'
import type { DiagramDoc } from '../../../src/shared/diagram-types'

const DOC: DiagramDoc = {
  nodes: [
    { id: 'web', label: 'Web Client', icon: 'client' },
    { id: 'api', label: 'API Server', icon: 'service' },
    { id: 'db', label: 'PostgreSQL', icon: 'logos:postgresql' },
  ],
  edges: [
    { id: 'e1', source: 'web', target: 'api', label: 'HTTPS', kind: 'sync' },
    { id: 'e2', source: 'api', target: 'db', label: 'SQL', kind: 'data' },
  ],
}

describe('serializeMermaid', () => {
  test('emits a flowchart LR header', () => {
    expect(serializeMermaid(DOC).split('\n')[0]).toBe('flowchart LR')
  })

  test('all nodes serialize as labeled rectangles regardless of icon', () => {
    const out = serializeMermaid(DOC)
    // Every node must use the rectangle ["label"] shape — no cylinders, no rounded.
    // This encodes the intent: icon is the node identity; Mermaid shape is uniform.
    expect(out).toContain('web["Web Client"]')
    expect(out).toContain('api["API Server"]')
    expect(out).toContain('db["PostgreSQL"]')
  })

  test('renders edges with labels and kind-specific arrows', () => {
    const out = serializeMermaid(DOC)
    // sync → -->, data → ==>, labels carried through
    expect(out).toContain('web -->|"HTTPS"| api')
    expect(out).toContain('api ==>|"SQL"| db')
  })

  test('async edges use a dotted arrow', () => {
    const out = serializeMermaid({
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ id: 'e', source: 'a', target: 'b', kind: 'async' }],
    })
    expect(out).toContain('a -.-> b')
  })

  test('sanitizes non-identifier ids to stable aliases', () => {
    const out = serializeMermaid({
      nodes: [{ id: 'node-1', label: 'One' }, { id: 'node-1-copy', label: 'Two' }],
      edges: [{ id: 'e', source: 'node-1', target: 'node-1-copy', label: 'x' }],
    })
    // hyphens become underscores; the edge references the same aliases
    expect(out).toContain('node_1["One"]')
    expect(out).toContain('node_1_copy["Two"]')
    expect(out).toContain('node_1 -->|"x"| node_1_copy')
  })

  test('escapes quotes in labels', () => {
    const out = serializeMermaid({
      nodes: [{ id: 'a', label: 'Say "hi"' }],
      edges: [],
    })
    expect(out).toContain('a["Say &quot;hi&quot;"]')
  })

  test('drops edges whose endpoints are not declared nodes', () => {
    const out = serializeMermaid({
      nodes: [{ id: 'a', label: 'A' }],
      edges: [{ id: 'e', source: 'a', target: 'ghost' }],
    })
    expect(out).not.toContain('ghost')
  })
})
