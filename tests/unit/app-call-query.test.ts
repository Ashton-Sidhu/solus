import { describe, expect, test } from 'bun:test'
import { callTermLabel, callTermText, parseCallQuery } from '@solus/workspace-ui/components/app/manage/lib/call-query'

describe('the query of the Activity section', () => {
  test('or joins two terms into one group, so a call that matches either one passes', () => {
    // WHY: `operation:summarizeRelease or caller:workflow` must not narrow to calls that are both.
    expect(parseCallQuery('operation:summarizeRelease or caller:workflow').groups).toEqual([
      [{ field: 'operation', value: 'summarizeRelease' }, { field: 'caller', value: 'workflow' }],
    ])
  })

  test('terms side by side must all match', () => {
    expect(parseCallQuery('outcome:failed version is 14').groups).toEqual([
      [{ field: 'outcome', value: 'failed' }],
      [{ field: 'version', value: '14' }],
    ])
    // `and` says what side by side already means.
    expect(parseCallQuery('outcome:failed and caller:agent').groups).toEqual([[{ field: 'outcome', value: 'failed' }], [{ field: 'caller', value: 'agent' }]])
  })

  test('words that name no field are one phrase, as the search before the query found them', () => {
    // WHY: a person who pastes part of an error finds the call with it, not every call with one of its words.
    expect(parseCallQuery('the model call took').groups).toEqual([[{ field: 'text', value: 'the model call took' }]])
    expect(parseCallQuery('timeout outcome:failed').groups).toEqual([[{ field: 'text', value: 'timeout' }], [{ field: 'outcome', value: 'failed' }]])
    // A field the log does not know is text to find, with its colon.
    expect(parseCallQuery('repo:sveltejs').groups).toEqual([[{ field: 'text', value: 'repo:sveltejs' }]])
  })

  test('a quoted value keeps its spaces', () => {
    expect(parseCallQuery('error:"took longer" or "rate limit"').groups).toEqual([
      [{ field: 'error', value: 'took longer' }, { field: 'text', value: 'rate limit' }],
    ])
  })

  test('field names take any case and their short names', () => {
    expect(parseCallQuery('OP:sync status:ok').groups).toEqual([[{ field: 'operation', value: 'sync' }], [{ field: 'outcome', value: 'ok' }]])
  })

  test('a value that can never match is named, and still sent, so the log says it found nothing', () => {
    const parsed = parseCallQuery('outcome:broken')
    expect(parsed.groups).toEqual([[{ field: 'outcome', value: 'broken' }]])
    expect(parsed.problem).toContain('ok, failed, or running')
    expect(parsed.tokens.find((token) => token.text === 'broken')?.kind).toBe('invalid')
    expect(parseCallQuery('caller:agent version is 14').problem).toBeNull()
  })

  test('a field still being typed adds no term', () => {
    expect(parseCallQuery('operation:').groups).toEqual([])
    expect(parseCallQuery('or').groups).toEqual([[{ field: 'text', value: 'or' }]])
    expect(parseCallQuery('   ').groups).toEqual([])
  })

  test('the pieces give the text back, so the colours sit under the right letters', () => {
    // WHY: the field draws the coloured pieces under the typed text; one lost space moves every colour after it.
    for (const text of ['operation:summarizeRelease or caller:workflow', 'version  is 14 "a b" x', 'error:"open', 'a:b:c']) {
      expect(parseCallQuery(text).tokens.map((token) => token.text).join('')).toBe(text)
    }
    expect(parseCallQuery('operation:sync or x').tokens.map((token) => token.kind)).toEqual(['field', 'value', 'space', 'operator', 'space', 'text'])
  })

  test('a term written back reads again as the same term', () => {
    for (const term of [{ field: 'error', value: 'took longer' } as const, { field: 'version', value: '14' } as const, { field: 'text', value: 'rate limit' } as const]) {
      expect(parseCallQuery(callTermText(term)).groups).toEqual([[term]])
    }
    expect(callTermLabel({ field: 'version', value: '14' })).toBe('version is 14')
  })
})
