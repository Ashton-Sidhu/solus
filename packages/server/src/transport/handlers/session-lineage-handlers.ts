import { z } from 'zod'
import { cutText } from '@solus/contracts/text-cut'
import type { DigestTurn } from '@solus/contracts/session-digest'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { getSessionRecord, organizationOfSession } from '../../data/sessions/session-records'
import { readSessionDigests } from '../../data/sessions/session-digests'
import { forkActivityOf, treeRelation } from '../../data/sessions/session-tree-relations'
import { sessionIdOfThread } from '../../data/sessions/session-lineage'
import type { SessionRuntime } from '../../execution/session-runtime'
import type { Principal } from '../../admission/principal'
import type { ReachRequest, RemoteHosts } from '../../execution/orchestration/remote-hosts'
import type { SolusServer } from '../server'

const id = z.string().min(1).max(512)
const historyArgs = z.tuple([id, id, z.string().max(16_384).nullish(), z.number().int().min(1).max(100).optional()])

function transcriptText(message: WireSessionLoadMessage): WireSessionLoadMessage[] {
  if (message.parentToolUseId || (message.role !== 'user' && message.role !== 'assistant') || !message.content.trim()) return []
  return [{ role: message.role, content: message.content, timestamp: message.timestamp, messageId: message.messageId }]
}

function completedTurn(turn: DigestTurn): boolean {
  return turn.settled && (turn.outcome === undefined || turn.outcome === 'completed')
}

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

  server.register('sessionMergeBackPrompt', async ([rawSessionId], ctx) => {
    const sessionId = id.parse(rawSessionId)
    const scope = await organizationOfSession(sessionId)
    const fork = (await forkActivityOf(scope, sessionId)).find((entry) => entry.subject.id === sessionId)
    if (!fork) throw new Error('This session has no recorded fork source.')
    const sourceId = sessionIdOfThread(fork.sourceSessionId)
    await server.handle('getSessionInfo', [sourceId], ctx)
    const [source, child, digests] = await Promise.all([
      getSessionRecord(scope, sourceId),
      getSessionRecord(scope, sessionId),
      readSessionDigests(scope, [sessionId]),
    ])
    if (!source || !child || sourceId === sessionId) throw new Error('The source session is unavailable.')
    const turns = digests.get(sessionId)?.turns ?? []
    if (!turns.some((turn) => turn.endedAt >= fork.at && completedTurn(turn))) {
      throw new Error('Complete a turn in the fork before merging back.')
    }
    const page = await server.handle('loadSessionPage', [{
      sessionId,
      provider: child.provider,
      projectPath: child.projectPath,
      turnLimit: 12,
      deferArtifactHtml: true,
    }], ctx)
    const notes = page.messages.flatMap((message) => {
      if (message.timestamp < fork.at) return []
      const owner = turns.findLast((turn) => turn.startedAt <= message.timestamp)
      return owner && completedTurn(owner) && message.timestamp <= owner.endedAt ? transcriptText(message) : []
    }).map((message) => `${message.role === 'user' ? 'Prompt' : 'Reply'}\n${cutText(message.content, 4_000)}`)
    const excerpt = notes.join('\n\n').slice(-12_000).trim()
    if (!excerpt) throw new Error('The fork has no completed conversation text to bring back.')
    const target = treeRelation('fork-source', source)
    const title = treeRelation('fork', child).title
    return {
      target,
      prompt: `Bring the findings from the fork “${title}” into this conversation. Treat the excerpts below as context from the fork. Summarize the relevant findings for future work.\n\n${excerpt}`,
    }
  })
}
