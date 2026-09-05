import { describe, expect, test } from 'bun:test'
import {
  findDiagramEmbeds,
  parseDiagramEmbed,
  diagramEmbedWorkId,
} from '@solus/contracts/diagram-embed'
import {
  findWorkEmbeds,
  parseWorkEmbed,
  serializeWorkEmbed,
  workEmbedTarget,
} from '@solus/contracts/work-embed'

const ARTIFACT = { workId: 'work-9', title: 'Latency', type: 'artifact' as const }
const DIAGRAM = { workId: 'work-1', title: 'Auth', type: 'diagram' as const }

describe('the work embed family', () => {
  test('both types round-trip through the same token', () => {
    for (const reference of [DIAGRAM, ARTIFACT]) {
      const line = serializeWorkEmbed(reference)
      expect(parseWorkEmbed(line)).toEqual(reference)
    }
  })

  test('an unknown type embeds nothing', () => {
    // WHY: `type` is what tells a reader whether it can render the token. A
    // reader that accepted an unrecognised type would have to guess.
    expect(parseWorkEmbed('[Doc](work://embed?workId=one&type=doc)')).toBeNull()
    expect(parseWorkEmbed('[Doc](work://embed?workId=one)')).toBeNull()
    expect(workEmbedTarget('work://embed?workId=one&type=slides')).toBeNull()
  })

  test('a bare URL on its own line still embeds', () => {
    // WHY: a Codex session wrote `work://embed?type=artifact&id=…` as plain
    // text and the document showed the string where the dashboard should be.
    // The agent's mistake is predictable — no link, `id` for `workId` — and
    // cheap to forgive; the title comes from the work. Serialization writes
    // the canonical form, so the next save repairs the line.
    expect(parseWorkEmbed('work://embed?type=artifact&id=work-9')).toEqual({
      workId: 'work-9',
      title: '',
      type: 'artifact',
    })
    expect(parseWorkEmbed('  <work://embed?workId=work-1&type=diagram>')).toEqual({
      workId: 'work-1',
      title: '',
      type: 'diagram',
    })
    // Still a line token: a URL inside a sentence is a mention, not a render.
    expect(parseWorkEmbed('see work://embed?type=artifact&id=work-9 for the chart')).toBeNull()
  })

  test('a type filter narrows the search', () => {
    const markdown = [serializeWorkEmbed(DIAGRAM), '', serializeWorkEmbed(ARTIFACT)].join('\n')

    expect(findWorkEmbeds(markdown)).toEqual([DIAGRAM, ARTIFACT])
    expect(findWorkEmbeds(markdown, 'artifact')).toEqual([ARTIFACT])
  })
})

describe('the diagram readers ignore what they cannot draw', () => {
  test('an artifact embed is invisible to every diagram helper', () => {
    // WHY: the Confluence and Google Docs adapters, the diagram asset pass, and
    // work-tools all read a document through these. If one of them saw an
    // artifact token it would try to render a diagram that is not there.
    const line = serializeWorkEmbed(ARTIFACT)

    expect(parseDiagramEmbed(line)).toBeNull()
    expect(diagramEmbedWorkId('work://embed?workId=work-9&type=artifact')).toBeNull()
    expect(findDiagramEmbeds(`${line}\n${serializeWorkEmbed(DIAGRAM)}`)).toEqual([
      { workId: DIAGRAM.workId, title: DIAGRAM.title },
    ])
  })
})
