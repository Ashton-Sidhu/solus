import { z } from 'zod'
import { hostPairRequestSchema } from '@solus/contracts/host-pairing'
import type { HostPairings } from '../../host/host-pairings'
import { isHostOwner } from '../../admission/principal'
import type { SolusServer, HandlerCtx } from '../server'
import type { RemoteHosts } from '../../execution/orchestration/remote-hosts'
import { transcriptText } from '../../execution/sessions/session-forks'

export function registerHostPairingHandlers(server: SolusServer, pairings: HostPairings, remoteHosts?: Pick<RemoteHosts, 'connectPaired' | 'disconnectPairing'>): void {
  const ownerOnly = (ctx: HandlerCtx) => {
    if (!isHostOwner(ctx.principal) || ctx.principal.via !== 'local') throw new Error('Only the local owner can pair hosts.')
  }
  server.register('hostsPair', ([input], ctx) => { ownerOnly(ctx); return pairings.pair(hostPairRequestSchema.parse(input), ctx.abortSignal) })
  server.register('hostsListPaired', (_args, ctx) => { ownerOnly(ctx); return pairings.snapshot() })
  server.register('hostsLinkHealth', (_args, ctx) => { ownerOnly(ctx); return pairings.health() })
  server.register('hostsUnlink', ([id], ctx) => {
    ownerOnly(ctx)
    const installationId = z.string().min(1).max(200).parse(id)
    const removed = pairings.unlink(installationId)
    if (removed) remoteHosts?.disconnectPairing(installationId)
    return { removed }
  })
  server.register('hostsPairClient', ([id, explicit], ctx) => {
    ownerOnly(ctx)
    return pairings.forClient(z.string().min(1).parse(id), z.boolean().optional().parse(explicit))
  })
  server.register('hostsForget', ([id], ctx) => { ownerOnly(ctx); return { removed: pairings.forget(z.string().min(1).parse(id)) } })
  server.register('hostsLinkedSessionPage', async (args, ctx) => {
    ownerOnly(ctx)
    const [installationId, sessionId, before, turnLimit] = z.tuple([
      z.string().min(1).max(200), z.string().min(1).max(512),
      z.string().max(16_384).nullable(), z.number().int().min(1).max(100),
    ]).parse(args)
    if (!remoteHosts) throw new Error('This host cannot read linked sessions.')
    const host = remoteHosts.connectPaired(installationId)
    if ('error' in host) throw new Error(host.error)
    const meta = await host.call('the linked session', () => host.api.getSessionInfo(sessionId))
    if (!meta || meta.sessionId !== sessionId) throw new Error('The linked machine has no record of this session.')
    const page = await host.call('the linked transcript', () => host.api.loadSessionPage({
      sessionId, provider: meta.provider, projectPath: meta.projectPath, before: before ?? undefined, turnLimit, deferArtifactHtml: true,
    }))
    return {
      meta: {
        sessionId, provider: meta.provider, customTitle: meta.customTitle,
        slug: meta.slug, firstMessage: meta.firstMessage, lastTimestamp: meta.lastTimestamp, size: meta.size,
        cwd: '', projectPath: '',
      },
      page: { messages: page.messages.flatMap(transcriptText), before: page.before },
    }
  })
}
