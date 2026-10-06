import { describe, expect, test } from 'bun:test'
import type { HubNotification, NotificationResource } from '@solus/contracts/notification-hub'
import { notificationDestination, resolveNotificationDestination } from '@solus/workspace-ui/components/notifications/lib/notification-actions'
import { NotificationHubClient } from '@solus/client-core/notifications/hub-client'
import { FakeNotificationSource } from './helpers/fake-notification-source'

// plans/015-notifications-hub.md v2 §5, stage 4: a notification leads to an
// existing destination on the source it came from, never to the window's
// organization or another host; every resource kind has a destination the
// workspace shells can open; and a choice cannot be sent twice while its answer
// is pending, nor at all while its source is offline or has revoked the row.

const row = (resource: NotificationResource, patch: Partial<HubNotification> = {}): HubNotification => ({
  id: 'n', eventId: 'e', organizationId: 'org-a', facts: { kind: 'task.assigned' }, resource, by: { kind: 'system' },
  createdAt: 1, summary: { title: 'Spec' }, readAt: null, archivedAt: null, ...patch,
})

const pr = { host: 'github.com', owner: 'acme', repo: 'api', number: 7, url: 'https://github.com/acme/api/pull/7' }

describe('notification destinations', () => {
  const resources: NotificationResource[] = [
    { kind: 'work', workId: 'w1', revisionId: 4 },
    { kind: 'task', taskId: 't1' },
    { kind: 'pr', pr },
    { kind: 'review_job', job: 'lens', pr, lensId: 'security' },
    { kind: 'automation', automationId: 'a1', runId: 'r1' },
  ]

  test('every resource opens on the source it came from, in its existing destination', () => {
    const kinds = resources.map((resource) => {
      const destination = notificationDestination(row(resource), 'workspace:org-a')
      expect('serverId' in destination.route && destination.route.serverId).toBe('workspace:org-a')
      return destination.route.kind
    })
    // The workspace shells open each of these kinds (`WORKSPACE_RESOURCE_KINDS`).
    expect(kinds).toEqual(['work', 'task', 'pull-request', 'pull-request', 'automation'])
  })

  test('a pull request is named by its repository, so a number never opens in another repository', () => {
    const destination = notificationDestination(row({ kind: 'pr', pr }), 'host:laptop')
    expect(destination.route).toEqual({ kind: 'pull-request', serverId: 'host:laptop', target: { number: 7, url: pr.url, expectedRepo: { host: 'github.com', owner: 'acme', repo: 'api' } } })
    expect(notificationDestination(row({ kind: 'review_job', job: 'guide', pr }), 'host:laptop').label).toBe('Open guide')
  })

  test('a finished automation run opens the conversation it ran in, on its own host', () => {
    const destination = notificationDestination(row({ kind: 'automation', automationId: 'a1', runId: 'r1', sessionId: 's1' }), 'host:mini')
    expect(destination).toEqual({ label: 'Open conversation', route: { kind: 'session', sessionId: 's1', serverId: 'host:mini' } })
  })

  test('a run row from an older host finds its conversation on the run record, and opens the automation when it cannot', async () => {
    const resource: NotificationResource = { kind: 'automation', automationId: 'a1', runId: 'r1' }
    const asked: string[] = []
    const found = await resolveNotificationDestination(row(resource), 'host:mini', async (automationId, runId) => {
      asked.push(`${automationId}/${runId}`)
      return { id: runId, automationId, startedAt: '', status: 'succeeded', sessionId: 's1' }
    })
    expect(asked).toEqual(['a1/r1'])
    expect(found.route).toEqual({ kind: 'session', sessionId: 's1', serverId: 'host:mini' })
    const unreachable = await resolveNotificationDestination(row(resource), 'host:mini', () => Promise.reject(new Error('offline')))
    expect(unreachable.route).toEqual({ kind: 'automation', automationId: 'a1', serverId: 'host:mini' })
  })
})

describe('choices from the hub', () => {
  const source = { sourceId: 'host:x', serverId: 'x', kind: 'host' as const, label: 'x' }

  test('a pending choice disables a second click; an offline source disables both', async () => {
    const fake = new FakeNotificationSource()
    fake.add({ id: 'n', createdAt: 1 })
    const client = new NotificationHubClient({ identity: 'me', connect: () => fake.link() })
    client.setHistoryVisible(true)
    client.setSources([source])
    await client.idle()
    const key = 'host:x\u0000n'
    const first = client.setArchived(key, true)
    expect(client.canChange(key)).toBe(false)
    expect(await client.setArchived(key, true)).toBe(false)
    expect(await first).toBe(true)
    await client.idle()
    expect(fake.calls.filter((call) => call === 'notificationsSetArchived')).toHaveLength(1)
  })

  test('a row whose access was lost is dropped when its source refuses the choice', async () => {
    const fake = new FakeNotificationSource()
    fake.add({ id: 'n', createdAt: 1 })
    const client = new NotificationHubClient({ identity: 'me', connect: () => fake.link() })
    client.setHistoryVisible(true)
    client.setSources([source])
    await client.idle()
    fake.items.delete('n')
    expect(await client.setRead('host:x\u0000n', true)).toBe(false)
    expect(client.rows.has('host:x\u0000n')).toBe(false)
  })
})
