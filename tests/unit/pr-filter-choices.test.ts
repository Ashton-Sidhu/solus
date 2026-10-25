import { describe, expect, test } from 'bun:test'
import { mergeFilterChoices, withHostChoices, type PrFilterOption } from '@solus/workspace-ui/components/prs/lib/pr-filter-menu'

describe('filter pickers merge the host choices with the loaded rows', () => {
  test('several repositories answer as one list, first seen first, one choice per value', () => {
    // WHY: an all-projects list asks every repository; the same label or
    // person in two of them must be one row in the picker.
    expect(mergeFilterChoices([
      [{ value: 'bug', color: 'd73a4a' }, { value: 'ui', color: '00ff00' }],
      [{ value: 'Bug', color: '000000' }, { value: 'docs', color: '0075ca' }],
      [],
    ])).toEqual([
      { value: 'bug', color: 'd73a4a' },
      { value: 'ui', color: '00ff00' },
      { value: 'docs', color: '0075ca' },
    ])
  })

  test('the loaded rows keep their counts and order, and the host adds only what they lack', () => {
    // WHY: a label or author outside the loaded page could not be picked at
    // all. The counted choices stay on top; a repeat would be two rows that
    // pick the same filter.
    const loaded: PrFilterOption[] = [
      { value: '', label: 'Anyone', count: 3 },
      { value: 'octo', label: 'octo', avatarUrl: 'https://avatars.test/octo', count: 3 },
    ]
    expect(withHostChoices(loaded, [
      { value: 'Octo', avatarUrl: 'https://avatars.test/other' },
      { value: 'hubot', avatarUrl: 'https://avatars.test/hubot' },
    ], 'author')).toEqual([
      ...loaded,
      { value: 'hubot', label: 'hubot', avatarUrl: 'https://avatars.test/hubot' },
    ])
  })

  test('a host label keeps the host colour the row chips use', () => {
    expect(withHostChoices([{ value: '', label: 'Any', count: 0 }], [{ value: 'p1', color: 'd73a4a' }], 'label'))
      .toEqual([{ value: '', label: 'Any', count: 0 }, { value: 'p1', label: 'p1', color: '#d73a4a' }])
  })
})
