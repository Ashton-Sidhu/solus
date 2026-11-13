import type { HubNotification, NotificationPr, NotificationResource } from '@solus/contracts/notification-hub'

const RESOURCE_NAMES = {
  work: 'works',
  task: 'tasks',
  session: 'sessions',
  pr: 'pull requests',
  review_job: 'guides and lenses',
  automation: 'automations',
  app: 'apps',
} as const satisfies Record<NotificationResource['kind'], string>

/** How this device answers a request to open a notification's resource. */
export type NativeDestination =
  /** Opens the pull request screen, once a host with its repository is found. */
  | { kind: 'pull-request'; pr: NotificationPr }
  /** Opens the session's thread on the host that sent the notification. */
  | { kind: 'thread'; sessionId: string }
  /** Opens the app's screen on the host that sent the notification. */
  | { kind: 'app'; appId: string }
  /** The row opens nothing: it only tells what happened. */
  | { kind: 'none' }
  | { kind: 'unsupported'; message: string }

/**
 * Where a notification opens on this device (plans/015-notifications-hub.md §6).
 * Pull requests, shared sessions, and apps open here. A removed share opens
 * nothing: the reader has no access to the session any more
 * (docs/plans/shared-with-you.md §4.4). An app is on the host that sent the
 * notification of its signal (docs/plans/apps.md §8.4), and opens by its id
 * there. The native client has no work, task, or automation screen yet
 * (plan 017 owns them), so those are reported as not openable here, with
 * words that say where they open instead.
 */
export function nativeDestination(notification: Pick<HubNotification, 'resource' | 'facts'>): NativeDestination {
  const { resource } = notification
  if (resource.kind === 'pr') return { kind: 'pull-request', pr: resource.pr }
  if (resource.kind === 'session') {
    return notification.facts.kind === 'session.unshared' ? { kind: 'none' } : { kind: 'thread', sessionId: resource.sessionId }
  }
  if (resource.kind === 'app') return { kind: 'app', appId: resource.appId }
  return { kind: 'unsupported', message: `This app does not show ${RESOURCE_NAMES[resource.kind]} yet. Open it in Solus on your computer or on the web.` }
}
