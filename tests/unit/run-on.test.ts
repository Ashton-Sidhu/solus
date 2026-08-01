import { describe, expect, test } from 'bun:test'
import type { Session } from '../../src/shared/types'
import { isRunOnHostLocked, repoKeyForPath } from '../../src/renderer/components/servers/run-on'

function session(overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: null,
    messages: [],
    status: 'idle',
    ...overrides,
  } as Session
}

describe('run-on host selection', () => {
  test('locks the host as soon as a session has started', () => {
    expect(isRunOnHostLocked(session())).toBe(false)
    expect(isRunOnHostLocked(session({ agentSessionId: 'session-1' }))).toBe(true)
    expect(isRunOnHostLocked(session({ messages: [{} as Session['messages'][number]] }))).toBe(true)
    expect(isRunOnHostLocked(session({ status: 'running' }))).toBe(true)
  })

  test('resolves the current path to its repository identity', () => {
    const identities = [{ path: '/work/solus', folderName: 'solus', repoKey: 'github.com/openai/solus' }]
    const repoKey = repoKeyForPath(identities, '/work/solus')

    expect(repoKey).toBe('github.com/openai/solus')
  })
})
