import type { HubNotification } from '@solus/contracts/notification-hub'
import type { ResourceRoute } from '../../../contexts/app/resource-routes'

/**
 * Where a notification leads (plans/015-notifications-hub.md §5): one exhaustive
 * mapping from its resource to an existing destination, named by the source it
 * came from. No row carries a callback or a command. Each destination already
 * holds its own actions: review controls on a work, starting a session on a
 * task, Guide and Lens on a pull request, Run now on an automation.
 */
export interface NotificationDestination {
  label: string
  route: ResourceRoute
}

export function notificationDestination(notification: HubNotification, serverId: string): NotificationDestination {
  const resource = notification.resource
  switch (resource.kind) {
    case 'work':
      return { label: 'Open work', route: { kind: 'work', workId: resource.workId, title: notification.summary.title, serverId } }
    case 'task':
      return { label: 'Open task', route: { kind: 'task', taskId: resource.taskId, serverId } }
    case 'pr':
    case 'review_job': {
      const { host, owner, repo, number, url } = resource.pr
      const label = resource.kind === 'pr' ? 'Open pull request' : resource.job === 'lens' ? 'Open lens' : 'Open guide'
      return { label, route: { kind: 'pull-request', target: { number, url: url ?? null, expectedRepo: { host, owner, repo } }, serverId } }
    }
    case 'automation':
      return { label: 'Open automation', route: { kind: 'automation', automationId: resource.automationId, serverId } }
  }
}
