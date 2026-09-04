import { describe, expect, test } from 'bun:test'
import {
  readSessionMeta,
  stampSessionMeta,
  stampSessionMetas,
} from '@solus/client-core/session-meta'
import type { SessionMeta } from '@solus/contracts/types'

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

  test('reads only the named host and stamps the result', async () => {
    // WHY: dispatch-client step 1 — every session ref names its host. The
    // bare-id probe across connected hosts is gone; a read dials exactly one
    // host and the answer carries that host's stamp.
    const calls: string[] = []
    const resolved = await readSessionMeta('laptop', 'target', {
      resolveId: (serverId) => serverId,
      apiFor: (serverId) => ({
        getSessionInfos: async () => {
          calls.push(serverId)
          return [meta('target')]
        },
      }),
    })

    expect(calls).toEqual(['laptop'])
    expect(resolved?.serverId).toBe('laptop')
  })

  test('a failed host read is a negative answer, never a fallback elsewhere', async () => {
    const resolved = await readSessionMeta('laptop', 'target', {
      resolveId: (serverId) => serverId,
      apiFor: () => ({
        getSessionInfos: async () => {
          throw new Error('offline')
        },
      }),
    })

    expect(resolved).toBeNull()
  })

  test('batches concurrent reads for one host and deduplicates the same id', async () => {
    // WHY: mounted rows ask independently, but one render turn must cross the
    // transport once rather than once for every session label.
    const batches: string[][] = []
    const hosts = {
      resolveId: (serverId: string) => serverId,
      apiFor: () => ({
        getSessionInfos: async (sessionIds: string[]) => {
          batches.push(sessionIds)
          return sessionIds.map(meta)
        },
      }),
    }

    const [one, two, oneAgain] = await Promise.all([
      readSessionMeta('laptop', 'one', hosts),
      readSessionMeta('laptop', 'two', hosts),
      readSessionMeta('laptop', 'one', hosts),
    ])

    expect(batches).toEqual([['one', 'two']])
    expect([one?.sessionId, two?.sessionId, oneAgain?.sessionId]).toEqual(['one', 'two', 'one'])
  })
})
