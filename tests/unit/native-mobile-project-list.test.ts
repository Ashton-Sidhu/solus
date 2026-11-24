import { describe, expect, test } from 'bun:test'
import { isContainerRoot } from '@solus/client-core/codebases'
import type { Codebase } from '@solus/contracts/codebases'
import type { ProjectEntry } from '@solus/contracts/types'
import { ThreadDirectory } from '../../apps/mobile/solus-core/features/threads/thread-directory'

// A project is one folder or one repository. A container (a folder that is no
// repository and that holds two or more repositories) is a codebase, never a
// project (docs/plans/codebases.md decision 14). The project pickers, the
// project filter, and the settings of the phone read `ThreadDirectory.projects()`,
// so the rule is there.

const project = (path: string): ProjectEntry => ({
  key: path, path, folderName: path.split('/').at(-1)!, addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', repositoryKey: null,
})

const INSTALLATION = { laptop: 'installation-laptop', server: 'installation-server' } as const
type HostId = keyof typeof INSTALLATION

function world(listed: { [host in HostId]: string[] }) {
  const hosts = (Object.keys(listed) as HostId[]).map((id) => ({ id, label: id }))
  // One connection for each host: the directory drops the answer of a connection that is not the current one.
  const connections = new Map(hosts.map(({ id }) => [id as string, {
    state: { sessionGeneration: 0 },
    api: {
      pinnedSessionsList: async () => [],
      sessionRecordList: async () => ({ records: [], indexing: false }),
      listProjects: async () => listed[id].map(project),
    },
  }]))
  const registry = { host: (id: string) => hosts.find((host) => host.id === id), hosts: () => hosts }
  const state = { codebases: [] as Codebase[] }
  const directory = new ThreadDirectory(
    registry as never, (hostId) => connections.get(hostId) as never, undefined, undefined, undefined, undefined,
    (hostId, path) => isContainerRoot(state.codebases, INSTALLATION[hostId as HostId], path),
  )
  const paths = () => directory.projects().map(({ hostId, project }) => `${hostId}:${project.path}`).sort()
  return { directory, state, paths }
}

const shop = (roots: Codebase['roots'], deletedAt: number | null = null): Codebase => ({ id: 'shop', name: 'shop', roots, updatedAt: 1, deletedAt })
const containerOnLaptop = { installationId: INSTALLATION.laptop, path: '/code/shop', name: 'shop', container: true as const }

describe('native project list and containers', () => {
  test('a container root is not a project, a folder inside it is, and the same path on a different host is', async () => {
    const { directory, state, paths } = world({
      laptop: ['/code/shop', '/code/shop/api', '/code/ui'],
      server: ['/code/shop'],
    })
    state.codebases = [shop([containerOnLaptop])]
    await Promise.all([directory.load('laptop'), directory.load('server')])
    expect(paths()).toEqual(['laptop:/code/shop/api', 'laptop:/code/ui', 'server:/code/shop'])
  })

  test('a root with no container mark stays a project, also when a codebase holds it', async () => {
    const { directory, state, paths } = world({ laptop: ['/code/api', '/code/ui'], server: [] })
    state.codebases = [shop([
      { installationId: INSTALLATION.laptop, path: '/code/api', name: 'api' },
      { installationId: INSTALLATION.laptop, path: '/code/ui', name: 'ui' },
    ])]
    await directory.load('laptop')
    expect(paths()).toEqual(['laptop:/code/api', 'laptop:/code/ui'])
  })

  test('the list follows the codebases: a new container leaves it, and a deleted one comes back', async () => {
    const { directory, state, paths } = world({ laptop: ['/code/shop', '/code/ui'], server: [] })
    await directory.load('laptop')
    expect(paths()).toEqual(['laptop:/code/shop', 'laptop:/code/ui'])
    let changes = 0
    directory.changes.subscribe(() => { changes++ })

    // The host made the codebase of the container after the projects were read.
    state.codebases = [shop([containerOnLaptop])]
    directory.followContainerRoots()
    expect(paths()).toEqual(['laptop:/code/ui'])
    expect(changes).toBe(1)

    // A change of the codebases that moves no project keeps the list, so no screen draws again.
    const held = directory.projects()
    directory.followContainerRoots()
    expect(directory.projects()).toBe(held)
    expect(changes).toBe(1)

    // A deleted codebase has no container: the folder is a project again.
    state.codebases = [shop([containerOnLaptop], 2)]
    directory.followContainerRoots()
    expect(paths()).toEqual(['laptop:/code/shop', 'laptop:/code/ui'])
  })
})
