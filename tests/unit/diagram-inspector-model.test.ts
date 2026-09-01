/// <reference types="bun-types" />
/**
 * The inspector claims two things about a node that the canvas can contradict:
 * how many edges touch it, and what kind of thing it is. Both are stated in the
 * header where a wrong answer is invisible until someone counts the arrows.
 *
 * Run with `bun run test:unit`.
 */
import { describe, expect, test } from 'bun:test'
import type { DiagramNode } from '@solus/contracts/diagram-types'
import {
  nodeDegree,
  nodeLinks,
  railKindWord,
} from '@solus/workspace-ui/components/diagram/lib/inspector-model'
import {
  cardFields,
  CARD_FIELD_LIMIT,
} from '@solus/workspace-ui/components/diagram/lib/node-card'

const label = (id: string) => `Label ${id}`

describe('nodeLinks', () => {
  const edges = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'c', target: 'a', label: 'writes' },
    { id: 'e3', source: 'b', target: 'c' },
  ]

  test('reports each edge from the inspected node’s side, not the document’s', () => {
    // The same edge is "out" for its source and "in" for its target — getting
    // this backwards would draw every arrow in the Links tab the wrong way.
    expect(nodeLinks('a', edges, label)).toEqual([
      { edgeId: 'e1', direction: 'out', otherLabel: 'Label b', label: '' },
      { edgeId: 'e2', direction: 'in', otherLabel: 'Label c', label: 'writes' },
    ])
  })

  test('omits edges that do not touch the node', () => {
    expect(nodeLinks('a', edges, label).map((l) => l.edgeId)).not.toContain('e3')
  })

  test('counts a self-edge on both sides, because it is genuinely both', () => {
    const links = nodeLinks('a', [{ id: 'loop', source: 'a', target: 'a' }], label)
    expect(nodeDegree(links)).toEqual({ in: 1, out: 1 })
  })

  test('degree matches the links the tab lists', () => {
    const links = nodeLinks('a', edges, label)
    expect(nodeDegree(links)).toEqual({ in: 1, out: 1 })
    expect(links.length).toBe(2)
  })
})

describe('railKindWord', () => {
  const node = (extra: Partial<DiagramNode>): DiagramNode => ({ id: 'n', label: 'N', ...extra })

  test('prefers the author’s own kind word', () => {
    expect(railKindWord(node({ subtitle: 'Broker', fields: [{ name: 'id' }] }))).toBe('Broker')
  })

  test('ignores a whitespace-only subtitle rather than showing a blank rail', () => {
    expect(railKindWord(node({ subtitle: '   ' }))).toBe('Node')
  })

  test('falls back to what the node structurally is', () => {
    expect(railKindWord(node({ group: true }))).toBe('Group')
    expect(railKindWord(node({ fields: [{ name: 'id' }] }))).toBe('Dataset')
    expect(railKindWord(node({}))).toBe('Node')
  })
})

describe('cardFields', () => {
  const many = Array.from({ length: CARD_FIELD_LIMIT + 3 }, (_, i) => ({ name: `f${i}` }))

  test('caps the card so a wide table cannot swamp the canvas', () => {
    const { shown, overflow } = cardFields(many)
    expect(shown).toHaveLength(CARD_FIELD_LIMIT)
    expect(overflow).toBe(3)
  })

  test('never claims overflow when everything already fits', () => {
    expect(cardFields([{ name: 'only' }])).toEqual({ shown: [{ name: 'only' }], overflow: 0 })
    expect(cardFields(undefined)).toEqual({ shown: [], overflow: 0 })
  })
})
