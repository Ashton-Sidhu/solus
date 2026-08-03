import { describe, expect, test } from 'bun:test'
import { serverConnections } from '../../src/client-core/server-connections'
import { LOCAL_SERVER_ID } from '../../src/client-core/server-registry'
import { cloneUrlForRepoKey, prepareHostCheckout } from '../../src/renderer/components/servers/run-on'

describe('automatic Run on repository preparation', () => {
  test('delegates the caller credential when preparing a different host', async () => {
    // WHY: the destination owns checkout placement, but private-repository
    // access must follow the caller rather than whichever account owns it.
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
  })

  test('does not export a credential when the target is the resolved local host', async () => {
    // WHY: a web client has no credential of its own — LOCAL_SERVER_ID resolves
    // onto the connection it is already talking to, which must clone as itself.
    let exported = false
    const localServerId = serverConnections.resolveId(LOCAL_SERVER_ID)
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
  })

  test('rejects an identity that cannot name a clone remote', () => {
    expect(cloneUrlForRepoKey('local-only')).toBeNull()
  })
})
