import { describe, expect, test } from 'bun:test'
import {
  distinctProjectLabels,
  groupByProject,
  localProjectParts,
  projectKeyLabel,
  projectKeyOf,
} from '@solus/client-core/project-identity'

/**
 * Every client lists projects by this one rule, so a project is one row with
 * one name on desktop, web and mobile alike.
 */
describe('project identity', () => {
  test('a repository is one project on every host; a folder without one is its host\'s alone', () => {
    const groups = groupByProject([
      { serverId: 'laptop', path: '/Users/me/web', repositoryKey: 'github.com/acme/web' },
      { serverId: 'box', path: '/srv/web', repositoryKey: 'github.com/acme/web' },
      { serverId: 'laptop', path: '/Users/me/notes', repositoryKey: null },
      { serverId: 'box', path: '/Users/me/notes', repositoryKey: null },
    ], (checkout) => checkout)
    expect(groups.map((group) => [group.key, group.checkouts.length])).toEqual([
      ['github.com/acme/web', 2],
      ['laptop:/Users/me/notes', 1],
      ['box:/Users/me/notes', 1],
    ])
  })

  test('a remote-dispatch checkout is its repository\'s, though no host names it', () => {
    // WHY: hosts leave dispatch clones out of their project list, so the clone
    // was its own local-only project beside the repository it holds.
    const dispatch = '/home/me/projects/solus-remote/140a4e7d/github.com/Acme/Web'
    expect(projectKeyOf({ serverId: 'box', path: dispatch })).toBe('github.com/acme/web')
    expect(projectKeyOf({ serverId: 'box', path: `${dispatch}/.git/solus/worktrees/fix` })).toBe('github.com/acme/web')
    expect(projectKeyOf({ serverId: 'box', path: '/home/me/projects/solus-remote/140a4e7d' })).toBe('box:/home/me/projects/solus-remote/140a4e7d')
  })

  test('a local-only key reads back as its host and folder, and names itself by the folder', () => {
    const key = projectKeyOf({ serverId: 'laptop', path: '/Users/me/notes' })
    expect(localProjectParts(key)).toEqual({ serverId: 'laptop', path: '/Users/me/notes' })
    expect(localProjectParts('github.com/acme/web')).toBeNull()
    expect(projectKeyLabel(key)).toBe('notes')
    expect(projectKeyLabel('github.com/acme/web')).toBe('web')
  })

  test('a shared name is told apart by owner for a repository and by host for a folder', () => {
    // WHY: two rows that read the same give the reader no way to choose.
    const labels = distinctProjectLabels([
      { key: 'github.com/acme/web', label: 'web' },
      { key: 'github.com/other/web', label: 'Web' },
      { key: 'laptop:/Users/me/api', label: 'api' },
      { key: 'box:/srv/api', label: 'api' },
      { key: 'github.com/acme/docs', label: 'docs' },
    ], (serverId) => (serverId === 'laptop' ? 'Laptop' : 'Build box'))
    expect(labels).toEqual(['acme/web', 'other/web', 'api · Laptop', 'api · Build box', 'docs'])
  })

  test('an owner and name two code hosts share falls back to the whole key', () => {
    const labels = distinctProjectLabels([
      { key: 'github.com/acme/web', label: 'web' },
      { key: 'gitlab.com/acme/web', label: 'web' },
    ], (serverId) => serverId)
    expect(labels).toEqual(['github.com/acme/web', 'gitlab.com/acme/web'])
  })
})
