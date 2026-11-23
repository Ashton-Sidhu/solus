import { afterAll, beforeAll, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { GitRepositoryStatus } from '@solus/contracts/types'

const runtime = globalThis as typeof globalThis & { $state?: unknown }
const previousState = runtime.$state
let RepositorySetupStore: typeof import('@solus/workspace-ui/contexts/git/repository-setup.store.svelte')['RepositorySetupStore']
beforeAll(async () => {
  runtime.$state = <T>(value: T) => value
  ;({ RepositorySetupStore } = await import('@solus/workspace-ui/contexts/git/repository-setup.store.svelte'))
})
afterAll(() => {
  if (previousState === undefined) delete runtime.$state
  else runtime.$state = previousState
})

// WHY: every tab switch remounted the Git section, and each mount read the
// checkout's repository status again, also for a checkout the client already
// held. The status changes only by Initialize Git, Publish, or a remote added
// outside Solus, which the manual refresh reads.
test("a checkout's repository status is read once across remounts, and a refresh reads it again", async () => {
  const reads: string[] = []
  const api = asHostApi({
    gitRepositoryStatus: async (cwd: string): Promise<GitRepositoryStatus> => {
      reads.push(cwd)
      return { isRepository: true } as GitRepositoryStatus
    },
  })
  const store = new RepositorySetupStore()
  store.ensure(api, 'host-a', '/repo')
  store.ensure(api, 'host-a', '/repo')
  // The first read answers; a remount then reads what the store holds.
  await store.refresh(api, 'host-a', '/repo')
  store.ensure(api, 'host-a', '/repo')
  store.ensure(api, 'host-a', '/other')
  expect(reads).toEqual(['/repo', '/other'])

  await store.refresh(api, 'host-a', '/repo')
  expect(reads).toEqual(['/repo', '/other', '/repo'])
})
