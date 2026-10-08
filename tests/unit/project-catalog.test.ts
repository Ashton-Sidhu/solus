import { describe, expect, test } from 'bun:test'
import {
  groupLogicalProjects,
  normalizeProjectRoot,
  projectOptionsFor,
  projectRefKey,
  projectScopeOptions,
} from '@solus/workspace-ui/contexts/projects/project-catalog'
import { SOLUS_WORKTREE_PATH_MARKER } from '@solus/contracts/types'

describe('normalizeProjectRoot', () => {
  test('strips the worktree marker segment so a worktree checkout collapses to its base project', () => {
    const worktreePath = `/repos/solus/${SOLUS_WORKTREE_PATH_MARKER}/feature-branch`
    expect(normalizeProjectRoot(worktreePath)).toBe('/repos/solus')
  })

  test('drops a trailing slash so it keys the same as the bare path', () => {
    expect(normalizeProjectRoot('/repos/solus/')).toBe('/repos/solus')
  })
})

describe('groupLogicalProjects', () => {
  const checkout = (serverId: string, projectRoot: string, repositoryKey: string | null, lastSeenAt = 1) =>
    ({ serverId, projectRoot, label: projectRoot.split('/').at(-1)!, lastSeenAt, repositoryKey })

  test('clones of one repository at different paths on different hosts are one project', () => {
    // WHY: docs/plans/project-model.md §1 — a project is a repository. The laptop
    // at /Users/me/web and the Linux box at /home/me/web hold the same work.
    const [project] = groupLogicalProjects([
      checkout('laptop', '/Users/me/web', 'github.com/acme/web'),
      checkout('linux', '/home/me/web', 'github.com/acme/web'),
    ], [])
    expect(project.key).toBe('github.com/acme/web')
    expect(project.checkouts.map((entry) => entry.serverId)).toEqual(['laptop', 'linux'])
  })

  test('unrelated repositories at the same path stay two projects', () => {
    const projects = groupLogicalProjects([
      checkout('laptop', '/workspace/app', 'github.com/acme/web'),
      checkout('linux', '/workspace/app', 'github.com/acme/api'),
    ], [])
    expect(projects.map((project) => project.key).sort()).toEqual(['github.com/acme/api', 'github.com/acme/web'])
  })

  test('a folder with no remote is its own project on its own host', () => {
    const projects = groupLogicalProjects([
      checkout('laptop', '/scratch', null),
      checkout('linux', '/scratch', null),
    ], [])
    expect(projects).toHaveLength(2)
  })

  test('a cloud project lists even with no checkout, and joins the checkouts that hold it', () => {
    const cloud = { id: 'p1', repositoryKey: 'github.com/acme/web', displayName: 'acme/web', defaultBranch: null, createdBy: null, createdAt: 0 }
    const projects = groupLogicalProjects([checkout('laptop', '/Users/me/web', 'github.com/acme/web')], [
      cloud,
      { ...cloud, id: 'p2', repositoryKey: 'github.com/acme/docs', displayName: 'acme/docs' },
    ])
    expect(projects.map((project) => [project.key, project.cloudProject?.id, project.checkouts.length])).toEqual([
      ['github.com/acme/web', 'p1', 1],
      ['github.com/acme/docs', 'p2', 0],
    ])
  })
})

describe('projectScopeOptions', () => {
  const checkout = (projectRoot: string, repositoryKey: string | null | undefined) =>
    ({ serverId: 'laptop', projectRoot, label: projectRoot.slice(1), lastSeenAt: 1, repositoryKey })

  test('a project is local-only once its host says it has no remote, and not before', () => {
    // WHY: the pull request page keeps a local-only project out of its reads.
    // A checkout its host has not yet named is not known to lack a remote;
    // treating it as local-only would drop a real repository from the list.
    const options = projectScopeOptions(
      groupLogicalProjects([checkout('/projects', null), checkout('/fresh', undefined), checkout('/web', 'github.com/acme/web')], []),
      () => true,
      () => 'laptop',
      null,
    )
    expect(Object.fromEntries(options.map((option) => [option.label, option.localOnly]))).toEqual({
      projects: true,
      fresh: false,
      web: false,
    })
  })
})

describe('projectOptionsFor', () => {
  const checkout = (serverId: string, projectRoot: string, repositoryKey: string | null) =>
    ({ serverId, projectRoot, label: projectRoot.split('/').at(-1)!, lastSeenAt: 1, repositoryKey })
  const hostLabel = (serverId: string) => (serverId === 'laptop' ? 'Laptop' : 'Build box')

  test('a project checked out on two hosts is one row', () => {
    const projects = groupLogicalProjects([
      checkout('laptop', '/Users/me/web', 'github.com/acme/web'),
      checkout('box', '/srv/web', 'github.com/acme/web'),
    ], [])
    const options = projectOptionsFor(['github.com/acme/web', 'github.com/acme/web'], projects, () => true, hostLabel, null)
    expect(options.map((option) => [option.key, option.label])).toEqual([['github.com/acme/web', 'web']])
  })

  test('projects that share a name are told apart within the list', () => {
    // WHY: two rows reading "web" give no way to pick the right one.
    const projects = groupLogicalProjects([
      checkout('laptop', '/Users/me/web', 'github.com/acme/web'),
      checkout('laptop', '/Users/me/other/web', 'github.com/other/web'),
      checkout('laptop', '/Users/me/scratch/api', null),
      checkout('box', '/srv/api', null),
    ], [])
    const options = projectOptionsFor(projects.map((project) => project.key), projects, () => true, hostLabel, null)
    expect(Object.fromEntries(options.map((option) => [option.key, option.label]))).toEqual({
      'github.com/acme/web': 'acme/web',
      'github.com/other/web': 'other/web',
      'laptop:/Users/me/scratch/api': 'api · Laptop',
      'box:/srv/api': 'api · Build box',
    })
    // Alone in its list, a project keeps its plain name.
    expect(projectOptionsFor(['github.com/acme/web'], projects, () => true, hostLabel, null)[0]!.label).toBe('web')
  })

  test('a key the catalog does not hold is still a row, named by its folder', () => {
    // A task filed in a folder no host has listed yet must still be a scope.
    const [option] = projectOptionsFor(['laptop:/Users/me/fresh'], [], (serverId) => serverId === 'laptop', hostLabel, null)
    expect(option).toMatchObject({ key: 'laptop:/Users/me/fresh', projectKey: '/Users/me/fresh', serverId: 'laptop', label: 'fresh', available: true })
  })
})
