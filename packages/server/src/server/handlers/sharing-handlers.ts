import { shareResourceSchema, shareSetLinkRequestSchema, shareSetRequestSchema, shareTransferRequestSchema } from '@solus/contracts/sharing'
import type { ShareManager } from '../../sharing/share-manager'
import type { SolusServer } from '../server'

/**
 * The share list of one session or work (docs/plans/multiplayer-sharing.md §4.1).
 * The access policy has already checked the caller's role against the resource
 * named in the request; the manager checks again with the rule each write needs.
 */
export function registerSharingHandlers(server: SolusServer, deps: { shares: ShareManager }): void {
  server.register('shareGet', (args, ctx) => {
    const resource = shareResourceSchema.parse(args[0].resource)
    return deps.shares.list(resource, ctx.principal)
  })
  // The three writes below answer the share manager's own promise.
  server.register('shareSet', (args, ctx) => deps.shares.setGrants(shareSetRequestSchema.parse(args[0]), ctx.principal))
  server.register('shareSetLink', (args, ctx) => deps.shares.setLink(shareSetLinkRequestSchema.parse(args[0]), ctx.principal))
  server.register('shareTransfer', (args, ctx) => deps.shares.transfer(shareTransferRequestSchema.parse(args[0]), ctx.principal))
}
