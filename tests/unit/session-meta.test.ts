import { describe, expect, test } from 'bun:test'
import {
  resolveSessionMetaRef,
  stampSessionMeta,
  stampSessionMetas,
} from '../../src/client-core/session-meta'
import type { SessionMeta } from '../../src/shared/types'

function meta(sessionId: string): SessionMeta {
  return {
    provider: 'codex',
    sessionId,
    slug: null,
    firstMessage: null,
    lastTimestamp: '',
    size: 0,
    cwd: '/repo',
    projectPath: '/repo',
  }
}

describe('scoped session metadata', () => {
  test('stamps single and listed metadata at the client read edge', () => {
    const single = meta('one')
    const listed = [meta('two'), meta('three')]

    expect(stampSessionMeta(single, 'studio')).toBe(single)
    expect(stampSessionMetas(listed, 'laptop')).toBe(listed)
    expect(single.serverId).toBe('studio')
    expect(listed.map((session) => session.serverId)).toEqual(['laptop', 'laptop'])
  })

  test('honors a scoped host without probing any other host', async () => {
    const calls: string[] = []
    const resolved = await resolveSessionMetaRef(
      { sessionId: 'target', serverId: 'laptop' },
      {
        connectedServerIds: () => ['primary', 'laptop'],
        resolveId: (serverId) => serverId,
        apiFor: (serverId) => ({
          getSessionInfo: async () => {
            calls.push(serverId)
            return meta('target')
          },
        }),
      },
    )

    expect(calls).toEqual(['laptop'])
    expect(resolved?.serverId).toBe('laptop')
  })

  test('probes primary first, then connected hosts, for a legacy bare id', async () => {
    const calls: string[] = []
    const resolved = await resolveSessionMetaRef(
      { sessionId: 'target' },
      {
        connectedServerIds: () => ['primary', 'studio', 'laptop'],
        resolveId: (serverId) => serverId,
        apiFor: (serverId) => ({
          getSessionInfo: async () => {
            calls.push(serverId)
            if (serverId === 'primary') throw new Error('offline')
            return serverId === 'studio' ? meta('target') : null
          },
        }),
      },
    )

    expect(calls).toEqual(['primary', 'studio'])
    expect(resolved?.serverId).toBe('studio')
  })
})
