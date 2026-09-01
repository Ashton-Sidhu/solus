import { describe, expect, test } from 'bun:test'
import type { InboxHostScope } from '../../packages/workspace-ui/src/components/tasks/lib/inbox-merge'
import {
  mergeInboxPullRequests,
  mergeInboxTickets,
} from '../../packages/workspace-ui/src/components/tasks/lib/inbox-merge'

function scope(serverId: string, projectKey: string): InboxHostScope {
  return {
    serverId,
    provider: 'github',
    externalKey: 'solus/solus',
    projects: [{ projectKey, projectLabel: projectKey.split('/').at(-1) ?? projectKey }],
    tickets: [{
      id: '42',
      providerId: 'github',
      projectKey,
      kind: 'task',
      title: 'Keep one ticket',
      body: '',
      status: 'todo',
      url: 'https://github.com/solus/solus/issues/42',
      labels: [],
      updatedAt: 1,
    }],
    pullRequests: [{
      provider: 'github',
      externalKey: 'solus/solus',
      url: 'https://github.com/solus/solus/pull/7',
      number: 7,
      title: 'Keep one pull request',
      headSha: 'abc',
      author: 'sidhu',
      authorAvatarUrl: '',
      state: 'open',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      draft: false,
      labels: [],
      additions: 1,
      deletions: 0,
    }],
  }
}

describe('task and PR inbox host merge', () => {
  test('deduplicates provider rows across hosts and retains every import home', () => {
    const rows = mergeInboxTickets([
      scope('work-laptop', '/repos/solus'),
      scope('shared-host', '/srv/solus'),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('github:solus/solus#42')
    expect(rows[0].locations).toEqual([
      { serverId: 'work-laptop', projectKey: '/repos/solus', projectLabel: 'solus' },
      { serverId: 'shared-host', projectKey: '/srv/solus', projectLabel: 'solus' },
    ])
  })

  test('uses the PR provider identity rather than a host id for deduplication', () => {
    const rows = mergeInboxPullRequests([
      scope('work-laptop', '/repos/solus'),
      scope('shared-host', '/srv/solus'),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('github:solus/solus#7')
    expect(rows[0].locations).toHaveLength(2)
  })

  test('does not merge the same issue number from different scopes', () => {
    const other = scope('work-laptop', '/repos/other')
    other.externalKey = 'solus/other'

    expect(mergeInboxTickets([scope('work-laptop', '/repos/solus'), other])).toHaveLength(2)
  })
})
