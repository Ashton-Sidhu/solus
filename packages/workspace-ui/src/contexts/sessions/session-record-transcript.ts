import { INITIAL_HISTORY_TURNS, requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import { serverConnections } from '@solus/client-core/server-connections'
import type { Message, SessionMeta } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { materializeSessionTranscript } from '../workspace/session-transcript'
import { loadArtifactFileBodies } from '../workspace/artifact-history'
import type { SurfaceContext } from '../app/surface-context.svelte'

export interface SessionRecordPageRequest {
  turnLimit: number
  /** The cursor of the page above: read the turns before it. */
  before?: string
  /** Tool results of the page above whose calls are in this one. */
  pendingMessages?: WireSessionLoadMessage[]
}

export interface SessionRecordPage {
  messages: Message[]
  /** The cursor to the next older page; null at the start of the session. */
  before: string | null
  pendingMessages?: WireSessionLoadMessage[]
}

/**
 * One page of the transcript the cloud mirrors for a session whose runner is
 * away (docs/plans/cloud-service-model.md, P2), read from the cloud host by
 * name rather than from a tab's run, so no tab has to exist. A page is cut at
 * user turns, so pages render one at a time.
 */
export async function readSessionRecordPage(workspace: SurfaceContext, serverId: string, meta: SessionMeta, request: SessionRecordPageRequest): Promise<SessionRecordPage> {
  const ctx = workspace.ctxForDirectory(meta.cwd)
  const page = await requestSessionHistoryPage(serverConnections.apiFor(serverId), {
    sessionId: meta.sessionId,
    projectPath: meta.projectPath,
    provider: meta.provider,
    turnLimit: request.turnLimit,
    before: request.before,
  })
  const history = request.pendingMessages?.length ? page.messages.concat(request.pendingMessages) : page.messages
  const result = materializeSessionTranscript(workspace, {
    sessionId: meta.sessionId,
    loadPath: meta.projectPath,
    displayCwd: meta.cwd,
    provider: meta.provider,
    ctx,
    turnLimit: request.turnLimit,
    before: request.before,
    pendingMessages: request.pendingMessages,
    serverId,
  }, page, await loadArtifactFileBodies((workId, version) => workspace.worksStore.history.bodyAtVersion(workId, version), history))
  return { messages: result.messages, before: result.before ?? null, pendingMessages: result.pendingMessages }
}

/** The newest page alone, for a reader that shows no older history. */
export async function loadSessionRecordTranscript(workspace: SurfaceContext, serverId: string, meta: SessionMeta): Promise<Message[]> {
  return (await readSessionRecordPage(workspace, serverId, meta, { turnLimit: INITIAL_HISTORY_TURNS })).messages
}
