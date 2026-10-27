import { describe, expect, test } from 'bun:test'
import { searchText, searchWords, searchName, searchTargetMatches, sessionNameScore, sessionEvidenceScore } from '@solus/contracts/session-search'

describe('one search rule on every client and host', () => {
  test('coding boundaries and accents keep the same meaning in stored text and queries', () => {
    expect(searchText('serverConnections JSONSchema Café v2')).toBe('server connections json schema cafe v 2')
    expect(searchWords('  Café  JSONSchema ')).toEqual(['cafe', 'json', 'schema'])
    expect(searchWords('very very')).toEqual(['very', 'very'])
    expect(searchName('serverConnections', ['connections'])).not.toBeNull()
    expect(searchName('VS Code', ['vscode'])).not.toBeNull()
  })
  test('typos need an explicit second pass and numbers are never prefixes or typos', () => {
    expect(searchName('Keybindings', ['keybindngs'])).toBeNull()
    expect(searchName('Keybindings', ['keybindngs'], true)?.typo).toBe(true)
    expect(searchName('#482', ['48'], true)).toBeNull()
    expect(searchName('#482', ['482'], true)?.typo).toBe(false)
  })
  test('exact old names beat newer prefixes before the page is cut', () => {
    const exact = sessionNameScore({ title: 'Tab' }, ['tab'])!
    const prefix = sessionNameScore({ title: 'Table details' }, ['tab'])!
    expect(exact.score).toBeGreaterThan(prefix.score)
    expect(exact.reason).toEqual({ field: 'title', text: 'Tab' })
    expect(sessionNameScore({ title: 'Other', branch: 'fix/ws-backoff' }, ['backoff'])?.reason.field).toBe('branch')
    expect(sessionNameScore({ id: 'session-1234', title: null }, ['session', '1234'])?.reason.field).toBe('id')
  })
  test('a phrase bonus stays positive without a corpus-size input', () => {
    expect(sessionEvidenceScore([1, 1], true, true)).toBeGreaterThan(sessionEvidenceScore([100, 100], false, false))
  })
  test('navigation uses provider identity and a portable text/time reference', () => {
    const target = { sourceSessionId: 'thread', messageId: 'provider-id', role: 'assistant', timestamp: 1000, text: 'the passage' }
    expect(searchTargetMatches(target, { id: 'provider-id', role: 'assistant', content: 'edited' })).toBe(true)
    expect(searchTargetMatches(target, { id: 'provider-id', sourceSessionId: 'other', role: 'assistant', content: 'edited' })).toBe(false)
    expect(searchTargetMatches({ ...target, messageId: null }, { role: 'assistant', content: 'the passage continues', timestamp: 1000 })).toBe(true)
    expect(searchTargetMatches({ ...target, messageId: null }, { role: 'assistant', content: 'the passage continues', timestamp: 9000 })).toBe(false)
    expect(searchTargetMatches({ ...target, messageId: null }, { role: 'assistant', sourceSessionId: 'other', content: 'the passage continues', timestamp: 1000 })).toBe(false)
  })
})
