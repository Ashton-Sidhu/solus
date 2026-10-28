import { describe, expect, test } from 'bun:test'
import { SearchQuery, searchText } from '@solus/contracts/search-query'
import { rankSessions, searchUseScore, searchTargetMatches, sessionNameScore, sessionEvidenceScore } from '@solus/contracts/session-search'

const name = (text: string, query: string, typos = false) => new SearchQuery(query).matchName(text, typos)
const q = (query: string) => new SearchQuery(query)

describe('one search rule on every client and host', () => {
  test('coding boundaries and accents keep the same meaning in stored text and queries', () => {
    // Runs written together are stored once more as one word, after the
    // words, so a phrase of the words is not split.
    expect(searchText('serverConnections JSONSchema Café v2')).toBe('server connections json schema cafe v 2 serverconnections jsonschema v2')
    expect(q('  Café  JSONSchema ').words).toEqual(['cafe', 'json', 'schema'])
    expect(q('very very').words).toEqual(['very', 'very'])
    expect(name('serverConnections', 'connections')).not.toBeNull()
    expect(name('VS Code', 'vscode')).not.toBeNull()
  })
  test('an identifier typed in lower case as one word finds its parts, in names and passages', () => {
    // WHY: people type "shikireviewhighlighter", not "shiki review highlighter".
    expect(name('ShikiReviewHighlighter usage', 'shikireviewhighlighter usage')).not.toBeNull()
    expect(name('Fix sidebar', 'fixsid')).not.toBeNull()
    expect(name('Inbox thread', 'inth')).toBeNull()
    expect(q('defaultmergemethod').passage('set defaultMergeMethod here', '[', ']')).toBe('set [defaultMergeMethod] here')
    // A word its first part holds still marks only that part.
    expect(q('default').passage('set defaultMergeMethod here', '[', ']')).toBe('set [default]MergeMethod here')
  })
  test('filler words are optional in a name unless the query is only filler', () => {
    // WHY: "fix the sidebar" names "Fix sidebar"; on real transcripts the
    // added "the" pushed title matches from MRR 0.90 to 0.19.
    expect(name('Fix sidebar', 'fix the sidebar')).not.toBeNull()
    expect(name('Fix sidebar', 'the')).toBeNull()
    expect(name('Fix the sidebar', 'fix the sidebar')!.score).toBeGreaterThan(name('Fix sidebar now', 'fix the sidebar')!.score)
  })
  test('a pull request is named by number, "pr 22889", or a pasted link, and never by a cut number', () => {
    const subject = { title: 'Other', pullRequest: '#22889 Fix sidebar' }
    expect(sessionNameScore(subject, q('pr 22889'))?.reason.field).toBe('pullRequest')
    expect(sessionNameScore(subject, q('#22889'))?.reason.field).toBe('pullRequest')
    expect(sessionNameScore(subject, q('https://github.com/o/r/pull/22889'))?.reason.field).toBe('pullRequest')
    expect(sessionNameScore(subject, q('pr 2288'))).toBeNull()
  })
  test('the worktree prefix does not name every worktree branch', () => {
    expect(sessionNameScore({ title: null, branch: 'solus/fix-sidebar' }, q('solus'))).toBeNull()
    expect(sessionNameScore({ title: null, branch: 'solus/fix-sidebar' }, q('fix sidebar'))?.reason.field).toBe('branch')
  })
  test('recent use reorders message matches of one kind, never across kinds', () => {
    const now = 100 * 86_400_000
    expect(searchUseScore(now, now)).toBeGreaterThan(searchUseScore(now - 30 * 86_400_000, now))
    // A read counts as use when it is later than the last activity.
    expect(searchUseScore(0, now, now)).toBe(searchUseScore(now, now))
    expect(sessionEvidenceScore([1, 1], true, false) + searchUseScore(0, now)).toBeGreaterThan(sessionEvidenceScore([100, 100], false, false) + searchUseScore(now, now))
  })
  test('one ranking orders every store: names, then message tiers, use only within a tier, one row per session', () => {
    // WHY: the host and the workspace service each read their own messages but
    // must order sessions by this one rule.
    const now = 100 * 86_400_000
    const candidate = (sessionId: string, title: string | null, lastActivity = 0) => ({ sessionId, title, branch: null, lastActivity })
    const candidates = [candidate('phrase', null, 0), candidate('spread', null, now), candidate('named', 'Pelican migration', 0), candidate('named', null, now), candidate('absent', null, now)]
    const counts: Record<string, number[]> = { phrase: [1, 1], spread: [1, 1], named: [0, 0], absent: [1, 0] }
    const ranked = rankSessions(q('pelican migration'), candidates, {
      counts: ({ sessionId }) => counts[sessionId]!,
      together: ({ sessionId }) => sessionId === 'phrase',
      phrase: ({ sessionId }) => sessionId === 'phrase',
    }, now)
    expect(ranked.map(({ candidate }) => candidate.sessionId)).toEqual(['named', 'phrase', 'spread'])
    expect(ranked[0]!.name?.reason.field).toBe('title')
    // Names only: no message is read, and a typo is tried when nothing matched.
    expect(rankSessions(q('pelicna'), candidates, null, now).map(({ candidate }) => candidate.sessionId)).toEqual(['named'])
  })
  test('task text follows the same rule: camelCase words, identifiers and optional filler', () => {
    expect(q('connections store').holdsEveryWord('check the serverConnections store')).toBe(true)
    expect(q('the connections').holdsEveryWord('serverConnections')).toBe(true)
    expect(q('defaultmergemethod').holdsEveryWord('set defaultMergeMethod')).toBe(true)
    expect(q('socket').holdsEveryWord('websocket')).toBe(false)
    expect(q('').holdsEveryWord('anything')).toBe(false)
    expect(q('merge store').heldWords('defaultMergeMethod')).toBe(1)
    expect(q('store').firstHit('the serverConnections store')).toBe(22)
  })
  test('typos need an explicit second pass and numbers are never prefixes or typos', () => {
    expect(name('Keybindings', 'keybindngs')).toBeNull()
    expect(name('Keybindings', 'keybindngs', true)?.typo).toBe(true)
    expect(name('#482', '48', true)).toBeNull()
    expect(name('#482', '482', true)?.typo).toBe(false)
  })
  test('exact old names beat newer prefixes before the page is cut', () => {
    const exact = sessionNameScore({ title: 'Tab' }, q('tab'))!
    const prefix = sessionNameScore({ title: 'Table details' }, q('tab'))!
    expect(exact.score).toBeGreaterThan(prefix.score)
    expect(exact.reason).toEqual({ field: 'title', text: 'Tab' })
    expect(sessionNameScore({ title: 'Other', branch: 'fix/ws-backoff' }, q('backoff'))?.reason.field).toBe('branch')
    expect(sessionNameScore({ id: 'session-1234', title: null }, q('session 1234'))?.reason.field).toBe('id')
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
