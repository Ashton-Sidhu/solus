import { describe, expect, test } from 'bun:test'
import { codebaseSchema } from '@solus/contracts/codebases'
import { codebaseMark, codebaseNameColor, parseCodebaseIcon, withCodebaseBadge } from '@solus/contracts/codebase-badge'

// docs/plans/codebases.md §9, "Badge": a codebase's mark tells codebases apart
// in the session sidebar, the breadcrumb, and the phone's session list. A
// person can choose its colour and its icon; with no choice, both come from
// the name, the same on each client.

describe('the icon field', () => {
  test('takes one or two letters or digits in capitals, or one emoji', () => {
    expect(parseCodebaseIcon('sp')).toEqual({ kind: 'letters', text: 'SP' })
    expect(parseCodebaseIcon(' 7 ')).toEqual({ kind: 'letters', text: '7' })
    expect(parseCodebaseIcon('🛒')).toEqual({ kind: 'emoji', emoji: '🛒' })
    expect(parseCodebaseIcon('👩🏽‍💻')).toEqual({ kind: 'emoji', emoji: '👩🏽‍💻' })
    expect(parseCodebaseIcon('🇨🇦')).toEqual({ kind: 'emoji', emoji: '🇨🇦' })
  })

  test('empty text is no choice, and other text is refused', () => {
    expect(parseCodebaseIcon('  ')).toBeNull()
    for (const text of ['abc', '🛒🛒', 'a🛒', '#']) expect(parseCodebaseIcon(text)).toBe('invalid')
  })
})

describe('the mark of a codebase', () => {
  test('with no choice, the initials and a colour from the name, the same each time', () => {
    const mark = codebaseMark({ name: 'Solus platform' })
    expect(mark).toEqual({ color: codebaseNameColor('Solus platform'), letters: 'SP', emoji: null })
    expect(codebaseMark({ name: 'Solus platform' })).toEqual(mark)
  })

  test('two names do not all get one colour', () => {
    const colors = new Set(['shop', 'billing', 'infra', 'docs', 'mobile', 'solus'].map(codebaseNameColor))
    expect(colors.size).toBeGreaterThan(1)
  })

  test('a choice wins over the name', () => {
    expect(codebaseMark({ name: 'shop', badge: { color: 'teal', icon: { kind: 'emoji', emoji: '🛒' } } }))
      .toEqual({ color: 'teal', letters: 'SH', emoji: '🛒' })
    expect(codebaseMark({ name: 'shop', badge: { icon: { kind: 'letters', text: 'Z' } } }).letters).toBe('Z')
  })
})

describe('a change of the badge', () => {
  test('clears one field and keeps the other, and leaves no empty badge on the record', () => {
    const both = withCodebaseBadge(undefined, { color: 'red', icon: { kind: 'letters', text: 'AB' } })
    expect(both).toEqual({ color: 'red', icon: { kind: 'letters', text: 'AB' } })
    expect(withCodebaseBadge(both, { color: null })).toEqual({ icon: { kind: 'letters', text: 'AB' } })
    expect(withCodebaseBadge({ color: 'red' }, { color: null })).toBeUndefined()
  })

  test('a record with a badge crosses the wire, and one with a bad badge is refused', () => {
    const record = { id: 'c', name: 'c', roots: [], updatedAt: 1, deletedAt: null }
    expect(codebaseSchema.parse({ ...record, badge: { color: 'teal' } }).badge).toEqual({ color: 'teal' })
    expect(codebaseSchema.parse(record).badge).toBeUndefined()
    expect(codebaseSchema.safeParse({ ...record, badge: { color: 'brown' } }).success).toBe(false)
  })
})
