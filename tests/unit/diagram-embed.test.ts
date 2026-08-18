import { describe, expect, test } from 'bun:test'
import {
  findDiagramEmbeds,
  parseDiagramEmbed,
  serializeDiagramEmbed,
} from '../../src/shared/diagram-embed'

describe('diagram embed references', () => {
  test('round-trips the canonical markdown token', () => {
    const reference = { workId: 'work-123', title: 'Auth [v2] \\ overview' }
    const markdown = serializeDiagramEmbed(reference)

    expect(markdown).toBe('[Auth \\[v2\\] \\\\ overview](work://embed?workId=work-123&type=diagram)')
    expect(parseDiagramEmbed(markdown)).toEqual(reference)
  })

  test('requires a standalone diagram embed link', () => {
    expect(parseDiagramEmbed('Before [Diagram](work://embed?workId=one&type=diagram)')).toBeNull()
    expect(parseDiagramEmbed('[Diagram](work://ref?workId=one&type=diagram)')).toBeNull()
    expect(parseDiagramEmbed('[Document](work://embed?workId=one&type=doc)')).toBeNull()
    expect(parseDiagramEmbed('[Missing id](work://embed?type=diagram)')).toBeNull()
  })

  test('finds embeds in document order', () => {
    const markdown = [
      '# Plan',
      '',
      serializeDiagramEmbed({ workId: 'one', title: 'One' }),
      '',
      'Text',
      serializeDiagramEmbed({ workId: 'two', title: 'Two' }),
    ].join('\n')

    expect(findDiagramEmbeds(markdown)).toEqual([
      { workId: 'one', title: 'One' },
      { workId: 'two', title: 'Two' },
    ])
  })
})
