import { describe, expect, test } from 'bun:test'
import { parseSessionHref } from '@solus/contracts/session-link'
import type { SessionRecord } from '@solus/contracts/types'
import {
  insertSessionReference,
  sessionReferenceCandidates,
  sessionReferenceOf,
} from '../../apps/mobile/src/features/threads/session-reference'
import type { SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'

function thread(hostId: string, sessionId: string, title: string, cwd: string | null = '/repo'): SolusThreadShell {
  const record = { sessionId, provider: 'codex', projectPath: '/repo', title, customTitle: null, slug: null, cwd, branch: null } as unknown as SessionRecord
  return { key: `${hostId}\u0000${sessionId}`, hostId, hostLabel: hostId, record }
}

const hrefOf = (text: string) => /\]\((session:\/\/[^)]+)\)/.exec(text)?.[1] ?? ''

describe('mobile session reference', () => {
  test('the inserted token is the session link the agent and transcript read back', () => {
    const { text } = insertSessionReference('', null, sessionReferenceOf(thread('host-a', 's-1', 'Fix [login] bug')))
    expect(text.startsWith('[Fix \\[login\\] bug](session://ref?')).toBe(true)
    expect(parseSessionHref(hrefOf(text))).toEqual({ provider: 'codex', sessionId: 's-1', serverId: 'host-a', cwd: '/repo' })
  })

  test('an unknown working directory still names the session and its host', () => {
    const { text } = insertSessionReference('', null, sessionReferenceOf(thread('host-a', 's-1', 'Plan', null)))
    expect(parseSessionHref(hrefOf(text))).toMatchObject({ sessionId: 's-1', serverId: 'host-a', cwd: '' })
  })

  test('the token replaces the selection at the caret and the caret lands after it, so typing continues', () => {
    const reference = sessionReferenceOf(thread('host-a', 's-1', 'Plan'))
    const result = insertSessionReference('see XX please', { start: 4, end: 7 }, reference)
    expect(result.text.startsWith('see [Plan](session://ref?')).toBe(true)
    expect(result.text.endsWith(') please')).toBe(true)
    expect(result.text.slice(result.caret)).toBe('please')
  })

  test('without a caret the token goes at the end, apart from the last word', () => {
    const result = insertSessionReference('compare with', null, sessionReferenceOf(thread('host-a', 's-1', 'Plan')))
    expect(result.text.startsWith('compare with [Plan](')).toBe(true)
    expect(result.caret).toBe(result.text.length)
  })

  test('the picker offers only this host and never the conversation itself', () => {
    const threads = [thread('host-a', 'own', 'Own'), thread('host-a', 's-1', 'Login fix'), thread('host-b', 's-2', 'Login other host'), thread('host-a', 's-3', 'Docs')]
    expect(sessionReferenceCandidates({ threads, hostId: 'host-a', currentSessionId: 'own', query: '' }).map(t => t.record.sessionId)).toEqual(['s-1', 's-3'])
    expect(sessionReferenceCandidates({ threads, hostId: 'host-a', currentSessionId: 'own', query: 'login' }).map(t => t.record.sessionId)).toEqual(['s-1'])
  })
})
