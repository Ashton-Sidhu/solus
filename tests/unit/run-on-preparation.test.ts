import { describe, expect, test } from 'bun:test'
import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { cloneUrlForRepoKey, prepareHostCheckout } from '@solus/workspace-ui/components/servers/run-on'

describe('automatic Run on repository preparation', () => {
  test('delegates the caller credential when preparing a different host', async () => {
    // WHY: the destination owns checkout placement, but private-repository
    // access must follow the caller rather than whichever account owns it.
    // Delegation exists only where a client machine does (desktop).
    const connections = serverConnections as unknown as { localServerId: () => string | null }
    const originalLocalServerId = connections.localServerId
    connections.localServerId = () => LOCAL_SERVER_ID
    const calls: Array<{ method: string; args: unknown }> = []
    const apis = {
      target: {
        setupPrepareProject: async (args: unknown) => {
          calls.push({ method: 'prepare', args })
          return { path: '/srv/projects/solus', projectKey: 'project', action: 'updated' as const }
        },
      },
      local: {
        githubExportCredential: async () => ({ accessToken: 'caller-token', login: 'caller' }),
      },
    }

    const result = await prepareHostCheckout(apis, 'remote-host', 'github.com/solus-sh/solus')

    expect(result).toEqual({ path: '/srv/projects/solus', action: 'updated' })
    expect(calls).toEqual([{
      method: 'prepare',
      args: {
        cloneUrl: 'https://github.com/solus-sh/solus.git',
        credential: { accessToken: 'caller-token', login: 'caller' },
      },
    }])
    connections.localServerId = originalLocalServerId
  })

  test('does not export a credential when the target is the client machine itself', async () => {
    // WHY: your own machine clones as itself — there is no other credential
    // store to borrow from. (On web, localServerId is null and every dispatch
    // target uses its own token; that arm is covered by the null default.)
    const connections = serverConnections as unknown as { localServerId: () => string | null }
    const originalLocalServerId = connections.localServerId
    connections.localServerId = () => LOCAL_SERVER_ID
    let exported = false
    const localServerId = LOCAL_SERVER_ID
    const args: unknown[] = []
    await prepareHostCheckout({
      target: {
        setupPrepareProject: async (request: unknown) => {
          args.push(request)
          return { path: '/srv/projects/solus', projectKey: 'project', action: 'updated' as const }
        },
      },
      local: {
        githubExportCredential: async () => {
          exported = true
          return { accessToken: 'caller-token', login: 'caller' }
        },
      },
    }, localServerId, 'github.com/solus-sh/solus')

    expect(exported).toBeFalse()
    expect(args).toEqual([{ cloneUrl: 'https://github.com/solus-sh/solus.git' }])
    connections.localServerId = originalLocalServerId
  })

  test('asks the target host to use the exact selected worktree', async () => {
    const requests: unknown[] = []
    await prepareHostCheckout({
      target: {
        setupPrepareProject: async (request: unknown) => {
          requests.push(request)
          return { path: '/srv/projects/solus', projectKey: 'project', action: 'updated' as const }
        },
      },
      local: {
        githubExportCredential: async () => { throw new Error('not used for the resolved local host') },
      },
    }, LOCAL_SERVER_ID, 'github.com/solus-sh/solus', '/srv/projects/solus/.git/solus/worktrees/release')

    // WHY: the selected worktree is a target-host path. Preparation validates
    // and returns it without trying to use that path on the source host.
    expect(requests).toEqual([{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      worktreePath: '/srv/projects/solus/.git/solus/worktrees/release',
    }])
  })

  test('asks the target host to materialize the selected origin branch', async () => {
    const requests: unknown[] = []
    await prepareHostCheckout({
      target: {
        setupPrepareProject: async (request: unknown) => {
          requests.push(request)
          return { path: '/srv/projects/solus', projectKey: 'project', action: 'updated' as const }
        },
      },
      local: {
        githubExportCredential: async () => { throw new Error('not used for the resolved local host') },
      },
    }, serverConnections.resolveId(LOCAL_SERVER_ID), 'github.com/solus-sh/solus', undefined, 'release')

    // WHY: the destination must materialize the chosen origin branch as the
    // worktree where the session runs. The source checkout remains untouched.
    expect(requests).toEqual([{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      baseBranch: 'release',
    }])
  })

  test('rejects an identity that cannot name a clone remote', () => {
    expect(cloneUrlForRepoKey('local-only')).toBeNull()
  })
})
