import { describe, expect, test } from 'bun:test'
import {
  stackKicker,
  stackLastEditedAt,
  stackTitle,
  type DocumentStackEntry,
} from '@solus/workspace-ui/components/work/lib/document-stack'

function entry(overrides: Partial<DocumentStackEntry> = {}): DocumentStackEntry {
  return { workId: 'w1', title: 'Spec', workType: 'doc', streaming: false, ...overrides }
}

describe('stack title', () => {
  test('one type names itself; a mixed write is files', () => {
    // WHY: the title states what is in the stack and cannot state two types.
    expect(stackKicker(['doc', 'doc'])).toBe('documents')
    expect(stackKicker(['slides', 'slides'])).toBe('decks')
    expect(stackKicker(['doc', 'diagram'])).toBe('files')
    expect(stackKicker(['artifact', 'artifact'])).toBe('artifacts')
    expect(stackKicker([undefined, 'doc'])).toBe('documents')
  })

  test('counts the works rather than naming one of them', () => {
    // WHY: the stack names works, not an act. A written title would repeat one
    // row and hide how many there are.
    expect(stackTitle([entry(), entry({ workId: 'w2', title: 'Plan' })])).toBe('2 documents')
  })
})

describe('stack rail', () => {
  test('states the newest edit across the stack', () => {
    // WHY: the rail says when the stack last changed. An older work must not
    // make a fresh write look stale.
    const at = stackLastEditedAt([
      entry({ updatedAt: '2026-01-01T00:00:00Z' }),
      entry({ workId: 'w2', updatedAt: '2026-03-01T00:00:00Z' }),
    ])
    expect(at).toBe(Date.parse('2026-03-01T00:00:00Z'))
  })

  test('states no time when no work has a readable one', () => {
    // WHY: a false time is worse than none. Zero tells the card to leave the
    // rail empty.
    expect(stackLastEditedAt([entry(), entry({ workId: 'w2', updatedAt: 'not a date' })])).toBe(0)
  })
})
