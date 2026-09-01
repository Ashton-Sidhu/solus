import { describe, expect, test } from 'bun:test'
import {
  updateListStatusSelection,
  type ListStatusOption,
} from '@solus/workspace-ui/components/ui/list-page/list-page'

const options: ListStatusOption[] = [
  { value: 'open', label: 'Open', count: 4 },
  { value: 'draft', label: 'Draft', count: 0 },
  { value: 'merged', label: 'Merged', count: 13 },
  { value: 'closed', label: 'Closed', count: 3 },
]

describe('list status selection', () => {
  test('uses the checkbox next state instead of toggling stale menu state', () => {
    // WHY: Bits UI changes its checkbox after selection. Toggling again in the
    // page owner can leave the checkmarks out of sync with the filtered rows.
    expect(updateListStatusSelection(options, ['open', 'merged'], 'closed', true)).toEqual([
      'open',
      'merged',
      'closed',
    ])
    expect(updateListStatusSelection(options, ['open', 'merged'], 'open', false)).toEqual([
      'merged',
    ])
  })

  test('keeps the menu order and removes stale values', () => {
    expect(updateListStatusSelection(options, ['merged', 'unknown'], 'draft', true)).toEqual([
      'draft',
      'merged',
    ])
  })
})
