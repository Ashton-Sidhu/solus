import { isApiMode } from '../../host/api-mode'
import { shareResourceSchema, shareSetLinkRequestSchema, shareSetRequestSchema, shareTransferRequestSchema } from '@solus/contracts/sharing'
import type { ShareManager } from '../../sharing/share-manager'
import { timeShareCall } from '../../sharing/share-timing'
import type { SolusServer } from '../server'

const LINKS_IN_CLOUD = 'Share links are available in Solus cloud. Open the cloud resource to share it.'

/**
 * The share list of one session or work (docs/plans/multiplayer-sharing.md §4.1).
 * The access policy has already checked the caller's role against the resource
 * named in the request; the manager checks again with the rule each write needs.
 */
export function registerSharingHandlers(server: SolusServer, deps: { shares: ShareManager }): void {
  server.register('shareGet', (args, ctx) => {
    const resource = shareResourceSchema.parse(args[0].resource)
    return timeShareCall('shareGet', resource, () => deps.shares.list(resource, ctx.principal))
  })
  // The three writes below answer the share manager's own promise.
  server.register('shareSet', (args, ctx) => {
    const request = shareSetRequestSchema.parse(args[0])
    if (request.link && !isApiMode()) throw new Error(LINKS_IN_CLOUD)
    return timeShareCall('shareSet', request.resource, () => deps.shares.setGrants(request, ctx.principal))
  })
  server.register('shareSetLink', (args, ctx) => {
    if (!isApiMode()) throw new Error(LINKS_IN_CLOUD)
    const request = shareSetLinkRequestSchema.parse(args[0])
    return timeShareCall('shareSetLink', request.resource, () => deps.shares.setLink(request, ctx.principal))
  })
  server.register('shareTransfer', (args, ctx) => {
    const request = shareTransferRequestSchema.parse(args[0])
    return timeShareCall('shareTransfer', request.resource, () => deps.shares.transfer(request, ctx.principal))
  })
}
