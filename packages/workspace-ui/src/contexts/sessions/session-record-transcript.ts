import { INITIAL_HISTORY_TURNS, requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import { serverConnections } from '@solus/client-core/server-connections'
import type { Message, SessionMeta } from '@solus/contracts/types'
import { materializeSessionTranscript } from '../workspace/session-transcript'
import { loadArtifactFileBodies } from '../workspace/artifact-history'
import type { SurfaceContext } from '../app/surface-context.svelte'

/**
 * The transcript the cloud mirrors for a session whose runner is away
 * (docs/plans/cloud-service-model.md, P2): one bounded page, read from the
 * cloud host by name rather than from a tab's run, so no tab has to exist.
 */
export async function loadSessionRecordTranscript(workspace: SurfaceContext, serverId: string, meta: SessionMeta): Promise<Message[]> {
  const ctx = workspace.ctxForDirectory(meta.cwd)
  const api = serverConnections.apiFor(serverId)
  const page = await requestSessionHistoryPage(api, {
    sessionId: meta.sessionId,
    projectPath: meta.projectPath,
    provider: meta.provider,
    turnLimit: INITIAL_HISTORY_TURNS,
  })
  return materializeSessionTranscript(workspace, {
    sessionId: meta.sessionId,
    loadPath: meta.projectPath,
    displayCwd: meta.cwd,
    provider: meta.provider,
    ctx,
    turnLimit: INITIAL_HISTORY_TURNS,
    serverId,
  }, page, await loadArtifactFileBodies(api, page.messages)).messages
}
