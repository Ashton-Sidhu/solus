import { describe, expect, test } from 'bun:test'
import type { ProjectEntry } from '@solus/contracts/types'
import { buildHomeListFilterMenu } from '../../apps/mobile/src/features/home/home-list-filter-menu'
import {
  projectRemovalFailure,
  projectRemovalPrompt,
  projectRemovalScope,
  removeProjectCheckouts,
} from '../../apps/mobile/src/features/home/project-removal'
import type { SolusProjectShell } from '../../apps/mobile/src/features/threads/thread-directory'

function project(hostId: string, path: string, repositoryKey: string | null): SolusProjectShell {
  const entry: ProjectEntry = { key: path, path, folderName: path.split('/').at(-1)!, addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', repositoryKey }
  return { key: `${hostId}\u0000${path}`, hostId, hostLabel: hostId.toUpperCase(), project: entry }
}

const projects = [
  project('h1', '/work/app', 'github.com/o/app'),
  project('h2', '/src/app', 'github.com/o/app'),
  project('h2', '/src/other', 'github.com/o/other'),
]

describe('remove project from the Home filter', () => {
  test('the removal covers the checkouts on every host, not only the filtered host', () => {
    const scope = projectRemovalScope(projects, 'github.com/o/app')!
    expect(scope.projects.map((checkout) => `${checkout.hostId}:${checkout.project.path}`)).toEqual(['h1:/work/app', 'h2:/src/app'])
    expect(projectRemovalScope(projects, 'github.com/o/gone')).toBeNull()
  })

  test('each connected host untracks its own checkout path; nothing is deleted', async () => {
    const calls: string[] = []
    const scope = projectRemovalScope(projects, 'github.com/o/app')!
    const result = await removeProjectCheckouts(scope.projects, (hostId) => ({
      untrackProject: async (path: string) => { calls.push(`${hostId}:${path}`) },
    }))
    expect(calls.sort()).toEqual(['h1:/work/app', 'h2:/src/app'])
    expect(result).toEqual({ changedHostIds: ['h1', 'h2'], kept: [] })
    expect(projectRemovalFailure(scope, result)).toBeNull()
  })

  test('a host that is away or refuses keeps its checkout, and the person is told which', async () => {
    const scope = projectRemovalScope(projects, 'github.com/o/app')!
    const away = await removeProjectCheckouts(scope.projects, (hostId) =>
      hostId === 'h1' ? null : { untrackProject: async () => { throw new Error('Not allowed') } })
    expect(away).toEqual({ changedHostIds: [], kept: ['H1 is not connected.', 'H2: Not allowed'] })
    expect(projectRemovalFailure(scope, away)).toEqual({
      title: 'Could not remove app',
      message: 'H1 is not connected.\nH2: Not allowed\n\nThe project stays listed on those hosts.',
    })

    const partial = await removeProjectCheckouts(scope.projects, (hostId) =>
      hostId === 'h1' ? { untrackProject: async () => {} } : null)
    expect(partial.changedHostIds).toEqual(['h1'])
    expect(projectRemovalFailure(scope, partial)?.message).toEndWith('stays listed on that host.')
  })

  test('the confirmation names the project and its hosts and says what stays', () => {
    expect(projectRemovalPrompt(projectRemovalScope(projects, 'github.com/o/app')!)).toEqual({
      title: 'Remove app?',
      message: 'This takes app off the project list on 2 hosts (H1, H2). Its sessions, tasks, and files stay. Open the folder again to list it again.',
    })
    expect(projectRemovalPrompt(projectRemovalScope(projects, 'github.com/o/other')!).message).toStartWith('This takes other off the project list on H2.')
  })

  test('the filter menu offers removal only for the selected project', () => {
    const removed: string[] = []
    const menu = (selectedProjectKey: string | null) => buildHomeListFilterMenu({
      environments: [],
      projects: [{ key: 'github.com/o/app', label: 'app' }],
      selectedEnvironmentId: null,
      selectedProjectKey,
      onEnvironmentChange: () => {},
      onProjectChange: () => {},
      onRemoveProject: (projectKey) => removed.push(projectKey),
    })
    const projectItems = (selectedProjectKey: string | null) => {
      const submenu = menu(selectedProjectKey).items.find((item) => item.title === 'Project')
      return submenu?.type === 'submenu' ? submenu.items : []
    }
    expect(projectItems(null).some((item) => item.destructive)).toBe(false)
    const remove = projectItems('github.com/o/app').find((item) => item.destructive)!
    expect(remove.title).toBe('Remove from projects')
    remove.onPress()
    expect(removed).toEqual(['github.com/o/app'])
  })
})
