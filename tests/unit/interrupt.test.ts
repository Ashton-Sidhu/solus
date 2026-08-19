import { describe, expect, test } from 'bun:test'
import { optionLabelParts } from '@solus/workspace-ui/components/conversation/lib/interrupt'

/**
 * §11 — an option label is one line the reader chooses by, so a recommendation is
 * a note beside it, never part of its name. Callers can only append it to the
 * label, so the card is what has to pull it back out.
 */
describe('option labels', () => {
  test('a trailing recommendation becomes a note, whatever separates it', () => {
    expect(optionLabelParts('Same row, rewrites in place (Recommended)')).toEqual({
      text: 'Same row, rewrites in place',
      note: 'recommended',
    })
    expect(optionLabelParts('Keep 500 · (recommended)')).toEqual({
      text: 'Keep 500',
      note: 'recommended',
    })
  })

  test('a label that only mentions the word keeps it, because it is the choice', () => {
    expect(optionLabelParts('Use the recommended defaults')).toEqual({
      text: 'Use the recommended defaults',
      note: '',
    })
  })
})
