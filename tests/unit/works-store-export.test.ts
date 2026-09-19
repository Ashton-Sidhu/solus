import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Work, WorkExportRequest } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

/** The store is a `.svelte.ts` module: outside the compiler, `$state` is an
 *  identity function and `$state.snapshot` a plain read. */
const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state

beforeEach(() => {
  connections.reset()
  runeHost.$state = stateShim
})

afterEach(() => {
  connections.reset()
  if (previousState === undefined) delete runeHost.$state
  else runeHost.$state = previousState
})

const work: Work = {
  id: 'work-a',
  title: 'Release plan',
  content: '# Release plan',
  preview: 'Release plan',
  type: 'doc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessionIds: [],
  agentProvider: 'claude-code',
  cwd: '/repo',
}

describe('exporting a work to a host path', () => {
  test('the host that owns the work writes it to the chosen path and answers where', async () => {
    // WHY: a work is a row on its host, not a file. The client never has the
    // bytes to write itself, so the export is the owner host's command, and
    // the path the person picked must reach it unchanged.
    const requests: WorkExportRequest[] = []
    connections.registerPrimary('host-other', {})
    connections.registerHost('host-a', {
      worksExport: async (request: WorkExportRequest) => {
        requests.push(request)
        return { path: '/Users/me/Documents/release_plan.md', bytes: 14 }
      },
    })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    store.works[work.id] = work
    store.rememberHost(work.id, 'host-a')

    const result = await store.exportToPath('work-a', '~/Documents/release_plan.md')

    expect(requests).toEqual([{ workId: 'work-a', path: '~/Documents/release_plan.md' }])
    expect(result).toEqual({ path: '/Users/me/Documents/release_plan.md', bytes: 14 })
  })
})
