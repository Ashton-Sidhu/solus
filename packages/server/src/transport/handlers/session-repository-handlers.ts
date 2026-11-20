import { z } from 'zod'
import { standingAllows } from '@solus/contracts/permissions'
import type { Principal } from '../../admission/principal'
import { getDb } from '../../db'
import type { ShareManager } from '../../sharing/share-manager'
import type { SessionBundleTransfers } from '../../sync/sessions/session-bundle-transfers'
import type { SessionArchiveWriter } from '../../sync/sessions/session-archive-writer'
import type { SolusServer } from '../server'
import type { SessionRuntime } from '../../execution/session-runtime'

const storageRow = z.object({ repository: z.string(), head: z.string().nullable() })

function principalKey(principal: Principal): string {
  switch (principal.kind) {
    case 'owner': return `owner:${principal.via}:${principal.deviceId ?? 'local'}`
    case 'org-member': return `member:${principal.organizationId}:${principal.userId}:${principal.deviceId}`
    case 'guest': return `guest:${principal.guestId}:${principal.deviceId}`
    case 'runner': return `runner:${principal.hostId}:${principal.ownerUserId}`
    case 'system': return 'system'
  }
}

/** A bundle contains full provider bodies, so both calls need prompt standing. */
export function registerSessionRepositoryHandlers(server: SolusServer, transfers: SessionBundleTransfers, shares: Pick<ShareManager, 'standingFor'>, runtime: SessionRuntime, archive: SessionArchiveWriter): void {
  server.register('sessionPrepare', ([request], handlerCtx) => {
    if (!runtime.sessionSync) throw new Error('Session sync is unavailable.')
    return runtime.sessionSync.prepare(request, handlerCtx.actor, handlerCtx.deviceId)
  })
  server.register('sessionRepositoryBundle', async ([request], ctx) => {
    const { sessionId, have } = z.object({ sessionId: z.string().min(1), have: z.string().regex(/^[a-f0-9]{40}$/).nullable() }).parse(request)
    if (!await archive.waitForSession(sessionId, 30_000)) {
      return { state: 'commit-failed' as const }
    }
    const row = storageRow.nullish().parse(getDb().prepare('SELECT repository, head FROM session_storage WHERE session_id = ?').get(sessionId))
    if (!row?.head) return { state: 'no-repository' as const }
    return transfers.start(sessionId, row.repository, have, principalKey(ctx.principal))
  })

  server.register('sessionRepositoryBundleChunk', async ([request], ctx) => {
    const { transferId, offset } = z.object({ transferId: z.uuid(), offset: z.number().int().nonnegative() }).parse(request)
    const key = principalKey(ctx.principal)
    const sessionId = transfers.sessionOf(transferId, key)
    if (!sessionId || !standingAllows(await shares.standingFor(ctx.principal, { kind: 'session', id: sessionId }), 'drive.prompt')) {
      throw new Error('Session bundle transfer is unavailable.')
    }
    return transfers.chunk(transferId, offset, key)
  })
}
