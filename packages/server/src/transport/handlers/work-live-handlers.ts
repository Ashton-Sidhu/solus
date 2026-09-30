import { resourceRoleAtLeast } from '@solus/contracts/sharing'
import { workLiveAwarenessRequestSchema, workLiveCloseRequestSchema, workLiveOpenRequestSchema, workLivePushRequestSchema } from '@solus/contracts/work-live'
import { attributionOf } from '../../admission/actor'
import { recordScopeOf } from '../../admission/principal'
import type { ShareManager } from '../../sharing/share-manager'
import type { WorkLiveManager } from '../../work-live/work-live-manager'
import type { SolusServer } from '../server'

/**
 * Live editing (docs/plans/work-review-and-live-editing.md, phase 3b). The
 * access policy lets anyone who can read a work open it and only an editor
 * push; the room's mode says the same to the client, so a viewer's editor is
 * read-only before it types.
 */
export function registerWorkLiveHandlers(server: SolusServer, deps: { live: WorkLiveManager; shares?: ShareManager }): void {
  server.register('workLiveOpen', async ([raw], ctx) => {
    const request = workLiveOpenRequestSchema.parse(raw)
    // A host that keeps no share list is its owner's alone.
    const role = deps.shares ? await deps.shares.roleFor(ctx.principal, { kind: 'work', id: request.workId }) : 'owner'
    return deps.live.open({ clientId: ctx.clientId, principal: ctx.principal, scope: recordScopeOf(ctx.principal), request, canEdit: resourceRoleAtLeast(role, 'editor') })
  })

  server.register('workLivePush', ([raw], ctx) => deps.live.push({
    clientId: ctx.clientId,
    request: workLivePushRequestSchema.parse(raw),
    author: attributionOf(ctx.actor),
  }))

  server.register('workLiveAwareness', ([raw], ctx) => {
    const { workId, update } = workLiveAwarenessRequestSchema.parse(raw)
    deps.live.awareness(ctx.clientId, workId, update)
  })

  server.register('workLiveClose', ([raw], ctx) => {
    deps.live.close(ctx.clientId, workLiveCloseRequestSchema.parse(raw).workId)
  })
}
