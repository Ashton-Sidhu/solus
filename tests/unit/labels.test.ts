import { describe, expect, test } from 'bun:test'
import { labelChipColor, labelTint } from '@solus/workspace-ui/components/ui/labels/label-color'
import {
  canCreateLabel,
  labelPickerOptions,
  toggleLabelName,
} from '@solus/workspace-ui/components/ui/labels/label-picker'

describe('label chips take the host colour as a pastel', () => {
  test('turns bare GitHub hex into a colour and leaves a CSS colour alone', () => {
    // WHY: GitHub reports `0e8a16`, which as a style value paints nothing, so
    // the chip would silently lose its tint. A provider that already reports
    // a CSS colour must not be given a second `#`; an empty colour still gets
    // a tint rather than an invalid one.
    expect(labelChipColor('0e8a16')).toBe('#0e8a16')
    expect(labelChipColor('#0e8a16')).toBe('#0e8a16')
    expect(labelChipColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)')
    expect(labelChipColor('')).toBe('var(--muted-foreground)')
  })

  test('a label with no colour at all is drawn in the brand accent', () => {
    // WHY: task labels are names alone. They share one chip with pull request
    // labels, so the chip decides the tint rather than every caller doing so.
    expect(labelTint(undefined)).toBe('var(--solus-accent)')
    expect(labelTint('0e8a16')).toBe('#0e8a16')
  })
})

describe('the label picker lists one row per name', () => {
  const labels = [{ name: 'Bug', color: 'd73a4a' }]
  const candidates = [
    { name: 'bug', color: 'd73a4a' },
    { name: 'design', color: '0075ca' },
    { name: ' ', color: '' },
  ]

  test('merges the record\'s labels with the candidates, case-insensitively, in name order', () => {
    // WHY: a label already on the record must stay uncheckable even when the
    // candidate list no longer carries it, and "Bug" and "bug" are one row,
    // not a pair the user can check twice.
    expect(labelPickerOptions(labels, candidates, '').map((option) => option.name)).toEqual([
      'Bug',
      'design',
    ])
  })

  test('narrows by the query without dropping the checked row', () => {
    expect(labelPickerOptions(labels, candidates, 'DES').map((option) => option.name)).toEqual([
      'design',
    ])
    expect(labelPickerOptions(labels, candidates, 'bu').map((option) => option.name)).toEqual(['Bug'])
  })

  test('offers to create only a name nobody has yet', () => {
    // WHY: creating "bug" beside "Bug" would give a task two spellings of one
    // label; a blank query is not a label.
    expect(canCreateLabel(labels, candidates, 'ready')).toBe(true)
    expect(canCreateLabel(labels, candidates, ' BUG ')).toBe(false)
    expect(canCreateLabel(labels, candidates, '   ')).toBe(false)
  })
})

describe('toggling a picker row', () => {
  test('adds a name once and removes it whatever its case', () => {
    expect(toggleLabelName(['bug'], 'design', true)).toEqual(['bug', 'design'])
    expect(toggleLabelName(['bug'], 'Bug', true)).toEqual(['bug'])
    expect(toggleLabelName(['bug', 'design'], 'BUG', false)).toEqual(['design'])
    expect(toggleLabelName(['bug'], '  ', true)).toEqual(['bug'])
  })
})
