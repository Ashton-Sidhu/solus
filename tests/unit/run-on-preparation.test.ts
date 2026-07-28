import { describe, expect, test } from 'bun:test'
import { cloneUrlForRepoKey, prepareHostCheckout } from '../../src/renderer/components/servers/run-on'

describe('automatic Run on repository preparation', () => {
  test('pulls a matching checkout before dispatching to its host', async () => {
    // WHY: choosing a host must run the prompt against current code, not whatever
    // revision happened to be left in that host's checkout.
    const calls: Array<{ method: string; args: unknown }> = []
    const api = {
      setupSyncProject: async (args: unknown) => {
        calls.push({ method: 'sync', args })
        return { path: '/srv/projects/solus', projectKey: 'project' }
      },
      setupCloneProject: async (args: unknown) => {
        calls.push({ method: 'clone', args })
        return { path: '/unused', projectKey: 'unused', auth: 'ssh' as const }
      },
    }

    const result = await prepareHostCheckout(api, 'github.com/solus-sh/solus', {
      path: '/srv/projects/solus',
      folderName: 'solus',
      repoKey: 'github.com/solus-sh/solus',
    })

    expect(result).toEqual({ path: '/srv/projects/solus', action: 'updated' })
    expect(calls).toEqual([{
      method: 'sync',
      args: {
        path: '/srv/projects/solus',
        cloneUrl: 'https://github.com/solus-sh/solus.git',
      },
    }])
  })

  test('clones automatically when the selected host has no checkout', async () => {
    // WHY: a missing remote checkout is an implementation detail, not another
    // project-selection decision the user should have to make.
    const calls: Array<{ method: string; args: unknown }> = []
    const api = {
      setupSyncProject: async () => ({ path: '/unused', projectKey: 'unused' }),
      setupCloneProject: async (args: unknown) => {
        calls.push({ method: 'clone', args })
        return { path: '/srv/projects/solus', projectKey: 'project', auth: 'ssh' as const }
      },
    }

    const result = await prepareHostCheckout(api, 'github.com/solus-sh/solus', null)

    expect(result).toEqual({ path: '/srv/projects/solus', action: 'cloned' })
    expect(calls).toEqual([{
      method: 'clone',
      args: { cloneUrl: 'https://github.com/solus-sh/solus.git' },
    }])
  })

  test('rejects an identity that cannot name a clone remote', () => {
    expect(cloneUrlForRepoKey('local-only')).toBeNull()
  })
})
