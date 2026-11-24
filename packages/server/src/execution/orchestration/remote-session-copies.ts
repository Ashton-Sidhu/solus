import type { SessionTree } from '@solus/contracts/session-digest'
import type { SessionRecord, SessionRecordUpsert } from '@solus/contracts/types'
import { storeRemoteSessionTree, type RemoteSessionNode } from '../../data/sessions/session-digests'
import { createLogger } from '../../logger'
import { sessionRecordUpsertWireSchema } from '../../sync/runner-protocol'
import type { RemoteHost } from './remote-hosts'

const log = createLogger('orchestration', 'remote-session-copies.ts')

/**
 * Keeps this host's copy of a session it started on another host, and of the
 * sessions below it there (docs/plans/session-digests.md decision 8): their
 * records, digests, and artifacts, so the parent's session tree is read from
 * this host's database, also while that host is offline. The copy is read
 * again from the other host's `sessionTree` when it announces a change, when
 * the connection comes back, and when `stop` ends the follow; reads never
 * overlap.
 */
export function copyRemoteSessionTree(host: RemoteHost, sessionId: string, parentSessionId: string): () => void {
  let reading: Promise<void> | null = null
  let again = false
  let stopped = false

  const read = async (): Promise<void> => {
    const tree = await host.call('the session tree', () => host.api.sessionTree(sessionId))
    await storeRemoteSessionTree(parentSessionId, remoteNodes(tree, host.hostId, sessionId, parentSessionId))
  }
  const refresh = (): void => {
    if (reading) {
      again = true
      return
    }
    reading = read()
      .catch((error) => log.warn('remote_session_copy_failed', { sessionId, hostId: host.hostId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        reading = null
        if (again) {
          again = false
          refresh()
        }
      })
  }
  const onChange = (payload: { sessionId: string }) => {
    if (!stopped && payload.sessionId === sessionId) refresh()
  }
  const unsubscribes = [
    host.events.subscribe('session.digestChanged', onChange),
    host.events.subscribe('session.artifactsChanged', onChange),
    host.onReconnected(() => { if (!stopped) refresh() }),
  ]
  refresh()
  return () => {
    if (stopped) return
    stopped = true
    for (const unsubscribe of unsubscribes) unsubscribe()
    // The exchange ended: one last read keeps what the session did by then.
    refresh()
  }
}

/** The other host's nodes as this host stores them, each record checked as a runner's report is. */
function remoteNodes(tree: SessionTree, hostId: string, rootSessionId: string, parentSessionId: string): RemoteSessionNode[] {
  return tree.nodes.map((node) => ({
    record: sessionRecordUpsertWireSchema.parse({
      ...recordFacts(node.record),
      // That host names its own sessions with no runner; here they are that host's.
      runnerHostId: node.record.runnerHostId ?? hostId,
      // That host does not know the session here that started the root.
      parentSessionId: node.record.sessionId === rootSessionId ? parentSessionId : node.record.parentSessionId,
    }),
    digest: node.digest,
    subagentExecutions: node.subagentExecutions,
    artifacts: node.artifacts,
  }))
}

/** The facts of a record that a host reports about a session. */
function recordFacts(record: SessionRecord): SessionRecordUpsert {
  return {
    sessionId: record.sessionId,
    provider: record.provider,
    projectPath: record.projectPath,
    lastActivityAt: record.lastActivityAt,
    projectRemote: record.projectRemote,
    title: record.title,
    customTitle: record.customTitle,
    status: record.status,
    execution: record.execution,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    createdAt: record.createdAt,
    size: record.size,
    cwd: record.cwd,
    slug: record.slug,
    isWorktree: record.isWorktree,
    branch: record.branch,
    projectRoot: record.projectRoot,
    delegation: record.delegation,
    place: record.place,
    startedBy: record.startedBy,
    codebaseId: record.codebaseId,
    attachedFolders: record.attachedFolders,
  }
}
