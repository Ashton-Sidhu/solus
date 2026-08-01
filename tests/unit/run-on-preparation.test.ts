import { describe, expect, test } from 'bun:test'
import { cloneUrlForRepoKey, prepareHostCheckout } from '../../src/renderer/components/servers/run-on'

describe('automatic Run on repository preparation', () => {
  test('delegates clone-versus-update to the destination host', async () => {
    // WHY: only the destination can authoritatively inspect its projects and
    // credentials, so the renderer sends repository intent rather than a path.
    const calls: Array<{ method: string; args: unknown }> = []
    const api = {
      setupPrepareProject: async (args: unknown) => {
        calls.push({ method: 'prepare', args })
        return { path: '/srv/projects/solus', projectKey: 'project', action: 'updated' as const }
      },
    }

    const result = await prepareHostCheckout(api, 'github.com/solus-sh/solus')

    expect(result).toEqual({ path: '/srv/projects/solus', action: 'updated' })
    expect(calls).toEqual([{
      method: 'prepare',
      args: { cloneUrl: 'https://github.com/solus-sh/solus.git' },
    }])
  })

  test('rejects an identity that cannot name a clone remote', () => {
    expect(cloneUrlForRepoKey('local-only')).toBeNull()
  })
})
