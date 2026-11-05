import { describe, expect, test } from 'bun:test'
import {
  findWorkEmbeds,
  parseWorkEmbed,
  serializeWorkEmbed,
  workEmbedTarget,
} from '@solus/contracts/work-embed'

const ARTIFACT = { workId: 'work-9', title: 'Latency', type: 'artifact' as const }

describe('the work embed family', () => {
  test('both types round-trip through the same token', () => {
    for (const reference of [ARTIFACT]) {
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
    // Still a line token: a URL inside a sentence is a mention, not a render.
    expect(parseWorkEmbed('see work://embed?type=artifact&id=work-9 for the chart')).toBeNull()
  })

  test('a token of an unknown type is not an embed', () => {
    // WHY: read as an embed, it would ask for a render that does not exist.
    expect(parseWorkEmbed('[Auth](work://embed?workId=work-1&type=chart)')).toBeNull()
    expect(workEmbedTarget('work://embed?workId=work-1&type=chart')).toBeNull()
  })
})
