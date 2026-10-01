import { describe, expect, mock, test } from 'bun:test'
import type { ProjectEntry, SetupCloneProjectResult } from '@solus/contracts/types'
import type { CheckoutHost, CheckoutStep } from '@solus/workspace-ui/contexts/workspace/repository-checkout'

/**
 * Cloud onboarding ends in a repository no machine may hold yet. The draft used
 * to open on `~` and clone only on Send, so the person landed in a session that
 * named no project and listed no files. Start now makes the repository a
 * project on its machine first, and the draft opens in that checkout.
 */

mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: { statusFor: () => 'online', hostFor: () => null },
}))
mock.module('@solus/workspace-ui/contexts/projects/projects.store.svelte', () => ({ projectsStore: {} }))

const { ensureRepositoryCheckout } = await import('@solus/workspace-ui/contexts/workspace/repository-checkout')
const { repositoryPreparationTitle } = await import('@solus/workspace-ui/components/onboarding/lib/repository-preparation')

const REPOSITORY = 'github.com/acme/web'
const CHECKOUT = '/data/projects/u1/web'

type CheckoutApi = ReturnType<CheckoutHost['api']>

interface FakeHost extends CheckoutHost {
  clones: string[]
  added: string[]
}

function fakeHost(options: { existing?: ProjectEntry[]; reachable?: boolean; cloneError?: string } = {}): FakeHost {
  const clones: string[] = []
  const added: string[] = []
  return {
    clones,
    added,
    reach: async () => options.reachable ?? true,
    api: () => ({
      listProjects: async () => options.existing ?? [],
      setupCloneProject: async (request: { cloneUrl: string }): Promise<SetupCloneProjectResult> => {
        clones.push(request.cloneUrl)
        if (options.cloneError) throw new Error(options.cloneError)
        return { path: CHECKOUT, projectKey: REPOSITORY, auth: 'token' }
      },
      trackRecentProject: async () => {},
    }),
    projects: {
      loadProjectsFor: async (_serverId: string, api: Pick<CheckoutApi, 'listProjects'>) => api.listProjects(),
      addProject: (serverId: string, _api: unknown, path: string) => {
        added.push(path)
        return { serverId, projectRoot: path }
      },
    },
  }
}

describe('making a repository a project on a machine', () => {
  test('clones it, says so while it clones, and lists the clone as a project', async () => {
    // WHY: the draft must open in a real checkout, and the person must see
    // which step the wait is on.
    const steps: CheckoutStep[] = []
    const host = fakeHost()
    const path = await ensureRepositoryCheckout('cloud', REPOSITORY, (step) => steps.push(step), host)
    expect(path).toBe(CHECKOUT)
    expect(steps).toEqual(['reaching', 'cloning'])
    expect(host.clones).toEqual(['https://github.com/acme/web.git'])
    // The clone is a project: the chip and every page list it from now on.
    expect(host.added).toEqual([CHECKOUT])
  })

  test('uses a checkout the machine already holds instead of cloning a second copy', async () => {
    const steps: CheckoutStep[] = []
    const host = fakeHost({
      existing: [{ path: CHECKOUT, folderName: 'web', repositoryKey: REPOSITORY } as ProjectEntry],
    })
    expect(await ensureRepositoryCheckout('cloud', REPOSITORY, (step) => steps.push(step), host)).toBe(CHECKOUT)
    expect(host.clones).toEqual([])
    expect(steps).toEqual(['reaching'])
  })

  test('fails with the clone’s reason, so onboarding can show it and try again', async () => {
    const host = fakeHost({ cloneError: 'Repository not found.' })
    await expect(ensureRepositoryCheckout('cloud', REPOSITORY, () => {}, host)).rejects.toThrow('Repository not found.')
    expect(host.added).toEqual([])
  })

  test('fails with a reason when the machine does not answer, before any clone', async () => {
    const host = fakeHost({ reachable: false })
    await expect(ensureRepositoryCheckout('cloud', REPOSITORY, () => {}, host)).rejects.toThrow('could not reach')
    expect(host.clones).toEqual([])
  })
})

describe('what the repository step says while it prepares', () => {
  test('names a cloud host that is starting apart from one it only connects to', () => {
    // WHY: starting a stopped cloud host takes minutes; a connection takes a moment.
    expect(repositoryPreparationTitle('reaching', REPOSITORY, 'Bills', true)).toBe('Starting Bills')
    expect(repositoryPreparationTitle('reaching', REPOSITORY, 'Bills', false)).toBe('Connecting to Bills')
  })

  test('names the repository and the machine while it clones', () => {
    expect(repositoryPreparationTitle('cloning', REPOSITORY, 'Bills', false)).toBe('Cloning web on Bills')
  })
})
