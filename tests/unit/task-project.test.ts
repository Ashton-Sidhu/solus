import { describe, expect, test } from 'bun:test'
import { taskProjectKey, taskProjectRoot } from '@solus/workspace-ui/lib/task-project'

describe('the one project a surface names for a task', () => {
  test('is the project the person is in when that project lists the task', () => {
    // WHY: one task source can be in many projects. A session started from a
    // task must open in the project the person looks at, not in the first one
    // that happens to list the same board.
    expect(taskProjectKey(['github.com/acme/app', 'github.com/acme/site'], 'github.com/acme/site')).toBe('github.com/acme/site')
  })

  test('is the first project that lists the task when the preferred one does not', () => {
    expect(taskProjectKey(['github.com/acme/app', 'github.com/acme/site'], 'github.com/acme/docs')).toBe('github.com/acme/app')
    expect(taskProjectKey(['github.com/acme/app'], null)).toBe('github.com/acme/app')
  })

  test('is none for a task that no known project lists', () => {
    // A task that only a session link brought to this client has no project.
    expect(taskProjectKey([], 'github.com/acme/app')).toBeNull()
  })
})

describe('the folder of a task on the host that reads it', () => {
  const checkouts = new Map([
    ['github.com/acme/app', [{ serverId: 'laptop', projectRoot: '/Users/me/app' }, { serverId: 'server', projectRoot: '/srv/app' }]],
    ['github.com/acme/site', [{ serverId: 'server', projectRoot: '/srv/site' }]],
  ])
  const checkoutsOf = (projectKey: string) => checkouts.get(projectKey) ?? []

  test('is the checkout on that host, never a path of another host', () => {
    // WHY: a path names a folder on one host only. A call that sends the
    // laptop's path to the server reads a folder that is not there.
    expect(taskProjectRoot(['github.com/acme/app'], 'server', checkoutsOf)).toBe('/srv/app')
    expect(taskProjectRoot(['github.com/acme/app'], 'laptop', checkoutsOf)).toBe('/Users/me/app')
  })

  test('looks in each project that lists the task', () => {
    expect(taskProjectRoot(['github.com/acme/docs', 'github.com/acme/site'], 'server', checkoutsOf)).toBe('/srv/site')
  })

  test('is none when the host has no checkout, or no host reads the task yet', () => {
    expect(taskProjectRoot(['github.com/acme/site'], 'laptop', checkoutsOf)).toBeNull()
    expect(taskProjectRoot(['github.com/acme/app'], null, checkoutsOf)).toBeNull()
  })
})
