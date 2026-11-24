import { z } from 'zod'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import { getSessionRecord, organizationOfSession } from '../../data/sessions/session-records'
import { mergeBackPrompt, transcriptText } from '../../execution/sessions/session-forks'
import type { SessionRuntime } from '../../execution/session-runtime'
import type { Principal } from '../../admission/principal'
import type { ReachRequest, RemoteHosts } from '../../execution/orchestration/remote-hosts'
import type { SolusServer } from '../server'
import { sessionReadsFor } from './session-reads'

const id = z.string().min(1).max(512)
const historyArgs = z.tuple([id, id, z.string().max(16_384).nullish(), z.number().int().min(1).max(100).optional()])

export function registerSessionLineageHandlers(
  server: SolusServer,
  runtime: Pick<SessionRuntime, 'stopSessionSubagent'>,
  hosts: Pick<RemoteHosts, 'connectTo'>,
  reachOf: (principal: Principal) => ReachRequest | null,
): void {
  server.register('stopSessionSubagent', (args) => {
    const [sessionId, toolId] = z.tuple([id, id]).parse(args)
    return runtime.stopSessionSubagent(sessionId, toolId)
  })

  server.register('sessionLineageHistory', async (args, ctx): Promise<SessionHistoryPage> => {
    const [parentId, childId, before, turnLimit] = historyArgs.parse(args)
    const child = await getSessionRecord(await organizationOfSession(parentId), childId)
    if (child?.parentSessionId !== parentId || !child.runnerHostId) {
      throw new Error('This session is not a remote child of the requested parent.')
    }
    // A parent grant is insufficient to read a child. Check the child's own
    // resource on this host before using a credential on the remote host.
    await server.handle('getSessionInfo', [childId], ctx)
    const reach = reachOf(ctx.principal)
    if (!reach) throw new Error('This connection cannot read the remote host.')
    const host = await hosts.connectTo(reach, child.runnerHostId)
    if ('error' in host) throw new Error(host.error)
    const page = await host.call('the child transcript', () => host.api.loadSessionPage({
      sessionId: childId,
      provider: child.provider,
      projectPath: child.projectPath,
      turnLimit: turnLimit ?? 12,
      before: before ?? undefined,
      deferArtifactHtml: true,
    }))
    // Files and signed assets belong to the remote host. This pane reads text.
    return { messages: page.messages.flatMap(transcriptText), before: page.before }
  })

  server.register('sessionMergeBackPrompt', async ([rawSessionId], ctx) => mergeBackPrompt(id.parse(rawSessionId), sessionReadsFor(server, ctx)))
}
