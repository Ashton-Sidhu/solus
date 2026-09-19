import { describe, expect, test } from 'bun:test'
import { pageRouteForResource, pageRouteFragment, pageRouteSection, parsePageRouteFragment } from '../../apps/client/src/lib/page-routes'

// docs/plans/cloud-service-model.md: the page shell on the account origin addresses one
// organization's workspace by hash. The share link `#/h/…` is a different door.

describe('the page shell routes', () => {
  test('every route round-trips through its fragment', () => {
    const routes = [
      { organizationId: 'org-1', page: 'tasks' },
      { organizationId: 'org-1', page: 'task', taskId: 'task_9' },
      { organizationId: 'org-1', page: 'works' },
      { organizationId: 'org-1', page: 'work', workId: 'work-a' },
      { organizationId: 'org-1', page: 'sessions' },
      { organizationId: 'org-1', page: 'session', sessionId: 'sess:1' },
      { organizationId: 'org-1', page: 'connections' },
    ] as const
    for (const route of routes) {
      expect(parsePageRouteFragment(pageRouteFragment(route))).toEqual(route)
    }
  })

  test('the organization alone lands on its tasks; a share link and the workspace are not pages', () => {
    expect(parsePageRouteFragment('#/w/org-1')).toEqual({ organizationId: 'org-1', page: 'tasks' })
    expect(parsePageRouteFragment('#/w/org-1/')).toEqual({ organizationId: 'org-1', page: 'tasks' })
    expect(parsePageRouteFragment('#/h/abc/s/secret')).toBeNull()
    expect(parsePageRouteFragment('#/chat/abc~local')).toBeNull()
    expect(parsePageRouteFragment('#/w/org-1/plans/x')).toBeNull()
    expect(parsePageRouteFragment('')).toBeNull()
  })

  test('the connections page has no id under it', () => {
    // WHY: the logins are the person's, one set per organization; there is no
    // "one connection" to address.
    expect(parsePageRouteFragment('#/w/org-1/connections')).toEqual({ organizationId: 'org-1', page: 'connections' })
    expect(parsePageRouteFragment('#/w/org-1/connections/claude-code')).toBeNull()
  })

  test('a resource opens on its page; a kind the shell has no page for opens nowhere', () => {
    // WHY: the shell answers `openResource` by changing the URL, and only a task,
    // a work, or a session has a URL here.
    expect(pageRouteForResource('org-1', { kind: 'task', taskId: 't1' })).toEqual({ organizationId: 'org-1', page: 'task', taskId: 't1' })
    expect(pageRouteForResource('org-1', { kind: 'work', workId: 'w1' })).toEqual({ organizationId: 'org-1', page: 'work', workId: 'w1' })
    expect(pageRouteForResource('org-1', { kind: 'session', sessionId: 's1', serverId: 'workspace:org-1' })).toEqual({ organizationId: 'org-1', page: 'session', sessionId: 's1' })
    expect(pageRouteForResource('org-1', { kind: 'chat', workId: 'w1', mode: 'resume' })).toBeNull()
    expect(pageRouteForResource('org-1', { kind: 'workspace' })).toBeNull()
  })

  test('the rail entry follows the route', () => {
    expect(pageRouteSection({ organizationId: 'o', page: 'task', taskId: 't' })).toBe('tasks')
    expect(pageRouteSection({ organizationId: 'o', page: 'work', workId: 'w' })).toBe('works')
    expect(pageRouteSection({ organizationId: 'o', page: 'sessions' })).toBe('sessions')
    expect(pageRouteSection({ organizationId: 'o', page: 'connections' })).toBe('connections')
  })
})
