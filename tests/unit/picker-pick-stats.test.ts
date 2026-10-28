import { describe, expect, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import type { PickerEntry, PickerList, PickerRow } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'
import { pickedEvent } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-pick-stats'

function memoryStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }
}

function conversation(sessionId: string, entryIndex: number): PickerEntry {
  return { kind: 'conversation', key: `session:${sessionId}`, entryIndex, meta: { sessionId } as SessionMeta, reason: { field: 'title', text: '' } } as PickerEntry
}

function listOf(sections: Array<[string, PickerEntry[]]>): PickerList {
  const rows: PickerRow[] = sections.flatMap(([section, entries]) => [{ kind: 'header', key: `header:${section}`, label: section, count: entries.length, hint: '' } as PickerRow, ...entries])
  const entries = sections.flatMap(([, entries]) => entries)
  return { rows, entries, taskCount: 0, sessionCount: entries.length, hiddenTaskCount: 0 }
}

describe('session picker pick stats', () => {
  const first = conversation('a', 0)
  const second = conversation('b', 1)
  const third = conversation('c', 2)
  const list = listOf([['top', [first]], ['sessions', [second]], ['messages', [third]]])
  const now = Date.UTC(2026, 9, 27)

  test('a choice states its place and section, and an empty box records nothing', () => {
    const storage = memoryStorage()
    expect(pickedEvent({ list, entry: third, query: 'pelican', sort: 'relevance', via: 'keybinding', storage, now }))
      .toMatchObject({ position: 3, section: 'messages', kind: 'conversation', matched_in: 'title', query_words: 1, repeat: 'new' })
    expect(pickedEvent({ list, entry: first, query: '   ', sort: 'relevance', via: 'click', storage, now })).toBeNull()
  })

  test('the same query choosing the same row again is the case a remembered pick would fix', () => {
    // WHY: this is the measure for building saved picks. A pick only helps
    // when the same query keeps choosing a row that is not first.
    const storage = memoryStorage()
    const pick = (entry: PickerEntry, query: string, at = now) => pickedEvent({ list, entry, query, sort: 'relevance', via: 'click', storage, now: at })!.repeat
    expect(pick(second, 'Release notes')).toBe('new')
    // The same words, typed differently, are the same query.
    expect(pick(second, 'release  NOTES', now + 1)).toBe('same_choice')
    expect(pick(third, 'release notes', now + 2)).toBe('other_choice')
    // After three weeks a query is new again.
    expect(pick(third, 'release notes', now + 22 * 86_400_000)).toBe('new')
  })

  test('this device keeps no query text and no session id', () => {
    const storage = memoryStorage()
    pickedEvent({ list, entry: second, query: 'secret project name', sort: 'relevance', via: 'click', storage, now })
    const stored = [...storage.values.values()].join('')
    expect(stored).not.toContain('secret')
    expect(stored).not.toContain('session:b')
  })
})
