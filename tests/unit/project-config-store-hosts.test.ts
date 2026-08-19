import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
const previousState = (globalThis as unknown as { $state?: unknown }).$state
let ProjectConfigStore: typeof import('@solus/workspace-ui/contexts/projects/project-config.store.svelte')['ProjectConfigStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ ProjectConfigStore } = await import('@solus/workspace-ui/contexts/projects/project-config.store.svelte'))
})

beforeEach(() => connections.reset())

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('ProjectConfigStore host isolation', () => {
  test('caches the same project root separately and saves through its host api', async () => {
    const savedBy: string[] = []
    const configA: ProjectConfig = { version: 1, taskProvider: 'local' }
    const configB: ProjectConfig = { version: 1, taskProvider: 'github' }
    connections.registerPrimary('host-a', {
      projectConfigLoad: async () => configA,
      projectConfigSave: async (_cwd: string, config: ProjectConfig) => {
        savedBy.push('host-a')
        return config
      },
    })
    connections.registerHost('host-b', {
      projectConfigLoad: async () => configB,
      projectConfigSave: async (_cwd: string, config: ProjectConfig) => {
        savedBy.push('host-b')
        return config
      },
    })
    const hostA = { serverId: 'host-a', api: connections.apiFor('host-a') }
    const hostB = { serverId: 'host-b', api: connections.apiFor('host-b') }
    const store = new ProjectConfigStore()

    await Promise.all([
      store.load(hostA, '/same/project'),
      store.load(hostB, '/same/project'),
    ])

    expect(store.configFor('host-a', '/same/project')?.taskProvider).toBe('local')
    expect(store.configFor('host-b', '/same/project')?.taskProvider).toBe('github')

    await store.save(hostB, '/same/project', { taskProvider: 'local' })
    expect(savedBy).toEqual(['host-b'])
  })
})
