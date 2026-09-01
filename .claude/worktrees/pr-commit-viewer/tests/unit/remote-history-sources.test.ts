import { describe, expect, test } from 'bun:test'
import {
  remoteHistorySources,
  type RemoteHistoryHosts,
} from '../../src/renderer/components/session/lib/remote-history-sources'
import type { ProjectIdentity } from '../../src/shared/types'

const SOLUS_REPO = 'github.com/sidhu/solus'

function identity(path: string, repoKey: string): ProjectIdentity {
  return { path, folderName: path.split('/').at(-1)!, repoKey }
}

function hosts(overrides: Partial<RemoteHistoryHosts> = {}): RemoteHistoryHosts {
  return {
    localServerId: 'local',
    remoteServerIds: () => ['laptop'],
    projectIdentities: async (serverId) =>
      serverId === 'local'
        ? [identity('/Users/me/solus', SOLUS_REPO)]
        : [identity('/home/me/solus', SOLUS_REPO)],
    isReachable: async () => true,
    ...overrides,
  }
}

describe('remote history sources', () => {
  test('the same repository is found on another host under its own path', async () => {
    // WHY: a checkout is /Users/me/solus here and /home/me/solus there. Matching
    // on path would find nothing, which is exactly the bug that makes a session
    // dispatched to a host vanish once its tab closes.
    const sources = await remoteHistorySources(hosts(), ['/Users/me/solus'])

    expect(sources).toEqual([
      { id: 'laptop:/home/me/solus', serverId: 'laptop', projectPath: '/home/me/solus' },
    ])
  })

  test('a host that has never held this repository is not asked for sessions', async () => {
    // WHY: the picker is scoped to the active project. Fanning out to every host
    // regardless would spend a round trip per machine to return nothing.
    const sources = await remoteHistorySources(
      hosts({
        projectIdentities: async (serverId) =>
          serverId === 'local'
            ? [identity('/Users/me/solus', SOLUS_REPO)]
            : [identity('/home/me/other', 'github.com/sidhu/other')],
      }),
      ['/Users/me/solus'],
    )

    expect(sources).toEqual([])
  })

  test('an unreachable host is skipped without blocking the hosts that answer', async () => {
    // WHY: a saved laptop is usually asleep. Dialling it would hold the picker's
    // loading state open long after every live host had already replied.
    let asked = false
    const sources = await remoteHistorySources(
      hosts({
        remoteServerIds: () => ['asleep', 'laptop'],
        isReachable: async (serverId) => serverId !== 'asleep',
        projectIdentities: async (serverId) => {
          if (serverId === 'asleep') asked = true
          return serverId === 'local'
            ? [identity('/Users/me/solus', SOLUS_REPO)]
            : [identity('/home/me/solus', SOLUS_REPO)]
        },
      }),
      ['/Users/me/solus'],
    )

    expect(asked).toBe(false)
    expect(sources.map((source) => source.serverId)).toEqual(['laptop'])
  })

  test('one failing host does not cost the others their sessions', async () => {
    const sources = await remoteHistorySources(
      hosts({
        remoteServerIds: () => ['broken', 'laptop'],
        projectIdentities: async (serverId) => {
          if (serverId === 'broken') throw new Error('the saved token was revoked')
          return serverId === 'local'
            ? [identity('/Users/me/solus', SOLUS_REPO)]
            : [identity('/home/me/solus', SOLUS_REPO)]
        },
      }),
      ['/Users/me/solus'],
    )

    expect(sources.map((source) => source.serverId)).toEqual(['laptop'])
  })

  test('a project missing from the local manifest resolves no repository to match', async () => {
    // WHY: repoKey comes from the local projects manifest. A project that was
    // never recorded there yields no remote rows — silently, so it is worth
    // pinning as known behaviour rather than discovering it as a bug.
    const sources = await remoteHistorySources(hosts(), ['/Users/me/never-opened'])

    expect(sources).toEqual([])
  })
})
