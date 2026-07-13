import { describe, test, expect } from 'bun:test'
import { parseDiagram, serializeDiagram, findParentCycleBreaks } from '../../../src/shared/diagram-types'
import { isSafeUrl } from '../../../src/shared/diagram-sanitize'

const RICH_NODE_DOC = {
  nodes: [
    {
      id: 'api',
      label: 'API Server',
      icon: 'service',
      subtitle: 'Node.js · 3 instances',
      badges: ['v2.1', 'autoscaling'],
      metrics: { P95: '42ms', RPS: '1.2k' },
      tags: ['production'],
      body: 'Handles REST requests.',
      actions: [{ on: 'click' as const, action: { do: 'focus' as const } }],
    },
    { id: 'db', label: 'PostgreSQL', icon: 'logos:postgresql' },
  ],
  edges: [
    { id: 'e1', source: 'api', target: 'db', label: 'SQL', kind: 'sync' as const },
    { id: 'e2', source: 'api', target: 'db', kind: 'async' as const, animated: true },
  ],
}

describe('parseDiagram — rich fields', () => {
  test('round-trips a rich node through serialize/parse unchanged', () => {
    const serialized = serializeDiagram(RICH_NODE_DOC)
    const parsed = parseDiagram(serialized)

    const apiNode = parsed.nodes.find((n) => n.id === 'api')!
    expect(apiNode.subtitle).toBe('Node.js · 3 instances')
    expect(apiNode.badges).toEqual(['v2.1', 'autoscaling'])
    expect(apiNode.metrics).toEqual({ P95: '42ms', RPS: '1.2k' })
    expect(apiNode.tags).toEqual(['production'])
    expect(apiNode.body).toBe('Handles REST requests.')
    expect(apiNode.actions).toHaveLength(1)
    expect(apiNode.actions![0].action.do).toBe('focus')
  })

  test('round-trips rich edge fields (kind, animated)', () => {
    const serialized = serializeDiagram(RICH_NODE_DOC)
    const parsed = parseDiagram(serialized)

    const syncEdge = parsed.edges.find((e) => e.id === 'e1')!
    expect(syncEdge.kind).toBe('sync')

    const asyncEdge = parsed.edges.find((e) => e.id === 'e2')!
    expect(asyncEdge.kind).toBe('async')
    expect(asyncEdge.animated).toBe(true)
  })

  test('round-trips node color and collapsed group state', () => {
    const doc = {
      nodes: [
        { id: 'g', label: 'Cluster', group: true, collapsed: true, color: '#60a5fa' },
        { id: 'svc', label: 'Service', parentId: 'g', color: '#4ade80' },
      ],
      edges: [],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    const group = parsed.nodes.find((n) => n.id === 'g')!
    expect(group.group).toBe(true)
    expect(group.collapsed).toBe(true)
    expect(group.color).toBe('#60a5fa')
    expect(parsed.nodes.find((n) => n.id === 'svc')!.color).toBe('#4ade80')
  })

  test('round-trips a valid node shape', () => {
    const doc = {
      nodes: [{ id: 'a', label: 'A', shape: 'diamond' as const }],
      edges: [],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.nodes[0].shape).toBe('diamond')
  })

  test('strips a shape outside the supported set', () => {
    const doc = { nodes: [{ id: 'a', label: 'A', shape: 'triangle' }], edges: [] }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].shape).toBeUndefined()
  })

  test('strips the default "rectangle" shape so data stays sparse', () => {
    // 'rectangle' is the implicit default — persisting it would be redundant.
    const doc = { nodes: [{ id: 'a', label: 'A', shape: 'rectangle' }], edges: [] }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].shape).toBeUndefined()
  })

  test('strips shape from a group container', () => {
    // A group is a pure container; the shape affordance is card-only.
    const doc = {
      nodes: [{ id: 'g', label: 'Cluster', group: true, shape: 'circle' }],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].shape).toBeUndefined()
    expect(parsed.nodes[0].group).toBe(true)
  })

  test('round-trips edge routing shape', () => {
    const doc = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', shape: 'straight' as const }],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.edges[0].shape).toBe('straight')
  })

  test('round-trips user-drawn handle anchors (sourceHandle/targetHandle)', () => {
    // Manual connections from non-default sides persist their anchor ids so the
    // edge re-renders attached to the same handles after reload.
    const doc = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', sourceHandle: 't-source', targetHandle: 'b-target' },
      ],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    const edge = parsed.edges[0]
    expect(edge.sourceHandle).toBe('t-source')
    expect(edge.targetHandle).toBe('b-target')
  })

  test('drops unknown action.do values defensively', () => {
    const doc = {
      nodes: [{
        id: 'x',
        label: 'X',
        actions: [
          { on: 'click', action: { do: 'focus' } },
          { on: 'click', action: { do: 'unknownFutureAction' } },
        ],
      }],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].actions).toHaveLength(1)
    expect(parsed.nodes[0].actions![0].action.do).toBe('focus')
  })

  test('parseDiagram still works with plain legacy nodes (no rich fields)', () => {
    const legacy = JSON.stringify({
      nodes: [
        { id: 'web', label: 'Web Client', icon: 'client' },
        { id: 'api', label: 'API Server' },
      ],
      edges: [{ id: 'e1', source: 'web', target: 'api' }],
    })
    const parsed = parseDiagram(legacy)
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.nodes[0].subtitle).toBeUndefined()
  })
})

describe('parseDiagram — entity fields & cardinality', () => {
  test('round-trips an entity node with typed fields', () => {
    const doc = {
      nodes: [
        {
          id: 'users',
          label: 'users',
          fields: [
            { name: 'id', type: 'uuid', key: 'pk' as const },
            { name: 'org_id', type: 'uuid', key: 'fk' as const, ref: 'orgs.id', nullable: true },
            { name: 'email', type: 'varchar(255)', key: 'unique' as const },
          ],
        },
      ],
      edges: [],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    const users = parsed.nodes.find((n) => n.id === 'users')!
    expect(users.fields).toHaveLength(3)
    expect(users.fields![0]).toEqual({ name: 'id', type: 'uuid', key: 'pk' })
    expect(users.fields![1].ref).toBe('orgs.id')
    expect(users.fields![1].nullable).toBe(true)
  })

  test('drops field rows with an empty/missing name', () => {
    const doc = {
      nodes: [
        {
          id: 'e',
          label: 'E',
          fields: [
            { name: 'id', type: 'uuid' },
            { name: '   ' },
            { type: 'varchar' },
          ],
        },
      ],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].fields).toHaveLength(1)
    expect(parsed.nodes[0].fields![0].name).toBe('id')
  })

  test('strips an invalid key but keeps the field', () => {
    const doc = {
      nodes: [{ id: 'e', label: 'E', fields: [{ name: 'id', key: 'primary' }] }],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].fields![0].name).toBe('id')
    expect(parsed.nodes[0].fields![0].key).toBeUndefined()
  })

  test('drops fields entirely when every row is malformed', () => {
    const doc = {
      nodes: [{ id: 'e', label: 'E', fields: [{ type: 'uuid' }, { name: '' }] }],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].fields).toBeUndefined()
  })

  test('group wins — fields removed from a group container', () => {
    const doc = {
      nodes: [{ id: 'g', label: 'Cluster', group: true, fields: [{ name: 'id' }] }],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].fields).toBeUndefined()
    expect(parsed.nodes[0].group).toBe(true)
  })

  test('round-trips valid edge cardinality', () => {
    const doc = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ id: 'e1', source: 'a', target: 'b', cardinality: '1-n' as const }],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.edges[0].cardinality).toBe('1-n')
  })

  test('strips cardinality outside the four-value set', () => {
    const doc = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ id: 'e1', source: 'a', target: 'b', cardinality: '2-many' }],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.edges[0].cardinality).toBeUndefined()
  })
})

describe('parentId cycle breaking', () => {
  // A cyclic parentId would make every parent-walking pass (layout, hit-testing,
  // render) loop forever and freeze the single-threaded renderer with no log, so
  // it MUST be detached before any consumer walks the chain. These tests fail if
  // cycle detection regresses — not merely if the output shape changes.

  test('parseDiagram detaches the node closing a two-group cycle', () => {
    // Two groups each nested in the other (the exact shape a drag-to-nest gesture
    // produced on the E-Commerce work that hung the app).
    const doc = {
      nodes: [
        { id: 'g1', label: 'Outer', group: true, parentId: 'g2' },
        { id: 'g2', label: 'Inner', group: true, parentId: 'g1' },
        { id: 'svc', label: 'Service', parentId: 'g1' },
      ],
      edges: [],
    }
    const parsed = parseDiagram(JSON.stringify(doc))
    // Exactly one of the two mutual parents is cut so the graph is acyclic, while
    // the non-cyclic child keeps its parent.
    expect(findParentCycleBreaks(parsed.nodes).size).toBe(0)
    const stillParented = parsed.nodes.filter((n) => n.parentId !== undefined)
    expect(stillParented.map((n) => n.id).sort()).toEqual(['g1', 'svc'])
    expect(parsed.nodes.find((n) => n.id === 'svc')!.parentId).toBe('g1')
  })

  test('parseDiagram breaks a self-referencing parentId', () => {
    const doc = { nodes: [{ id: 'a', label: 'A', parentId: 'a' }], edges: [] }
    const parsed = parseDiagram(JSON.stringify(doc))
    expect(parsed.nodes[0].parentId).toBeUndefined()
  })

  test('findParentCycleBreaks leaves a valid nesting chain untouched', () => {
    const nodes = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'c' },
      { id: 'c' },
    ]
    expect(findParentCycleBreaks(nodes).size).toBe(0)
  })

  test('findParentCycleBreaks ignores a parentId pointing at a missing node', () => {
    // A dangling reference is not a cycle — it must not be flagged for detach.
    const nodes = [{ id: 'a', parentId: 'ghost' }]
    expect(findParentCycleBreaks(nodes).size).toBe(0)
  })
})

describe('isSafeUrl', () => {
  test('allows http URLs', () => {
    expect(isSafeUrl('http://example.com')).toBe(true)
  })

  test('allows https URLs', () => {
    expect(isSafeUrl('https://docs.example.com/guide')).toBe(true)
  })

  test('allows mailto URLs', () => {
    expect(isSafeUrl('mailto:user@example.com')).toBe(true)
  })

  test('rejects javascript: scheme', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })

  test('rejects file: scheme', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false)
  })

  test('rejects data: URIs', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  test('rejects invalid / unparseable URLs', () => {
    expect(isSafeUrl('not a url at all')).toBe(false)
  })
})

// parseDiagram runs on both agent-authored tool input and persisted content at
// load time, so structural problems must be repaired, not thrown: a throw at
// load blanks the canvas (data loss), while a dangling reference or duplicate
// id that survives into the renderer errors inside xyflow.
describe('parseDiagram — reference repair', () => {
  test('drops edges whose endpoints are not declared nodes', () => {
    const doc = {
      nodes: [{ id: 'a', label: 'A' }],
      edges: [
        { id: 'ok', source: 'a', target: 'a' },
        { id: 'dangling-target', source: 'a', target: 'ghost' },
        { id: 'dangling-source', source: 'ghost', target: 'a' },
      ],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.edges.map((e) => e.id)).toEqual(['ok'])
  })

  test('drops duplicate node ids, keeping the first occurrence', () => {
    const doc = {
      nodes: [
        { id: 'a', label: 'First' },
        { id: 'a', label: 'Second' },
        { id: 'b', label: 'B' },
      ],
      edges: [],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.nodes.find((n) => n.id === 'a')!.label).toBe('First')
  })

  test('drops duplicate edge ids, keeping the first occurrence', () => {
    const doc = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [
        { id: 'e', source: 'a', target: 'b', label: 'first' },
        { id: 'e', source: 'b', target: 'a', label: 'second' },
      ],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.edges[0].label).toBe('first')
  })

  test('detaches a parentId that references a nonexistent node', () => {
    const doc = {
      nodes: [{ id: 'child', label: 'Child', parentId: 'no-such-group' }],
      edges: [],
    }
    const parsed = parseDiagram(serializeDiagram(doc))
    expect(parsed.nodes[0].parentId).toBeUndefined()
  })

  test('drops nodes without an id and coerces a missing label', () => {
    const json = JSON.stringify({
      nodes: [{ label: 'No id' }, { id: 'ok' }],
      edges: [],
    })
    const parsed = parseDiagram(json)
    expect(parsed.nodes).toHaveLength(1)
    // A missing label would throw inside layout's `label.length` estimate.
    expect(parsed.nodes[0].label).toBe('')
  })

  test('repairs detail sub-diagrams too: dangling edges and cardinality', () => {
    const doc = {
      nodes: [
        {
          id: 'svc',
          label: 'Service',
          detail: {
            nodes: [{ id: 'inner', label: 'Inner' }],
            edges: [
              { id: 'd1', source: 'inner', target: 'missing' },
              { id: 'd2', source: 'inner', target: 'inner', cardinality: 'bogus' },
            ],
          },
        },
      ],
      edges: [],
    }
    const parsed = parseDiagram(serializeDiagram(doc as never))
    const detail = parsed.nodes[0].detail!
    expect(detail.edges.map((e) => e.id)).toEqual(['d2'])
    expect(detail.edges[0].cardinality).toBeUndefined()
  })
})
