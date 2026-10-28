import { describe, expect, test } from 'bun:test'
import {
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

  test('a local-only key reads back as its host and folder, and names itself by the folder', () => {
    const key = projectKeyOf({ serverId: 'laptop', path: '/Users/me/notes' })
    expect(localProjectParts(key)).toEqual({ serverId: 'laptop', path: '/Users/me/notes' })
    expect(localProjectParts('github.com/acme/web')).toBeNull()
    expect(projectKeyLabel(key)).toBe('notes')
    expect(projectKeyLabel('github.com/acme/web')).toBe('web')
  })
})
