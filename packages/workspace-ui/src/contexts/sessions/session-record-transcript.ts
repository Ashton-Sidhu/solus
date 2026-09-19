import { requestSessionHistoryPage, RESTORED_TRANSCRIPT_LIMIT } from '@solus/client-core/session-history-page'
import { serverConnections } from '@solus/client-core/server-connections'
import type { Message, SessionMeta } from '@solus/contracts/types'
import { materializeSessionTranscript } from '../workspace/session-transcript'
import type { WorkspaceContext } from '../workspace/workspace.context.svelte'

/**
 * The transcript the cloud mirrors for a session whose runner is away
 * (docs/plans/cloud-service-model.md, P2): one bounded page, read from the
 * cloud host by name rather than from a tab's run, so no tab has to exist.
 */
export async function loadSessionRecordTranscript(workspace: WorkspaceContext, serverId: string, meta: SessionMeta): Promise<Message[]> {
  const ctx = workspace.ctxForDirectory(meta.cwd)
  const page = await requestSessionHistoryPage(serverConnections.apiFor(serverId), {
    sessionId: meta.sessionId,
    projectPath: meta.projectPath,
    provider: meta.provider,
    limit: RESTORED_TRANSCRIPT_LIMIT,
  }, ctx)
  return materializeSessionTranscript(workspace, {
    sessionId: meta.sessionId,
    loadPath: meta.projectPath,
    displayCwd: meta.cwd,
    provider: meta.provider,
    ctx,
    limit: RESTORED_TRANSCRIPT_LIMIT,
    serverId,
  }, page).messages
}
