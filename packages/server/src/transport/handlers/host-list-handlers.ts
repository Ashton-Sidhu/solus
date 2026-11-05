import { z } from 'zod'
import { hostListingSchema } from '@solus/contracts/host-list'
import type { HostEventMap } from '@solus/contracts/host-events'
import { isHostOwner } from '../../admission/principal'
import { putHostListing, readHostList, removeHostListing } from '../../host/host-list'
import type { HandlerCtx, SolusServer } from '../server'

/**
 * The owner's host list (plans/031 D7). The list is the owner's alone: an
 * organization owner who administers the machine does not read it.
 */
export function registerHostListHandlers(server: SolusServer, deps: { broadcast: (topic: 'host.listChanged', payload: HostEventMap['host.listChanged']) => void }): void {
  const ownerOnly = (ctx: HandlerCtx): void => {
    if (!isHostOwner(ctx.principal)) throw new Error('Only the owner of this host has a host list here.')
  }

  server.register('hostListRead', (_args, ctx) => {
    ownerOnly(ctx)
    return readHostList()
  })

  server.register('hostListPut', ([listing], ctx) => {
    ownerOnly(ctx)
    putHostListing(hostListingSchema.parse(listing))
    deps.broadcast('host.listChanged', {})
  })

  server.register('hostListRemove', ([id], ctx) => {
    ownerOnly(ctx)
    if (removeHostListing(z.string().min(1).parse(id))) deps.broadcast('host.listChanged', {})
  })
}
