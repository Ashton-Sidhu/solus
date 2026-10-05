import type { ShareResource } from '@solus/contracts/sharing'
import { serializeRoute } from '../workspace/routing/codec'
import type { RouteRef } from '../workspace/routing/route-registry'

/**
 * The address that opens a resource in the web app on the account origin: the
 * app's own route for it on its organization's workspace service. A member who
 * is signed in lands on it with their own account; anyone else signs in first.
 * Unlike a guest link it holds no secret, so it admits only the people the
 * resource is shared with.
 */
export function appLinkUrl(accountOrigin: string, resource: ShareResource, cloudServerId: string): string {
  return `${accountOrigin.replace(/\/$/, '')}/#${serializeRoute(routeFor(resource, cloudServerId))}`
}

function routeFor(resource: ShareResource, serverId: string): RouteRef {
  switch (resource.kind) {
    case 'task': return { name: 'task', params: { taskId: resource.id, serverId } }
    case 'work': return { name: 'work', params: { workId: resource.id, serverId } }
    case 'session': return { name: 'sessionRecord', params: { sessionId: resource.id, serverId } }
  }
}
