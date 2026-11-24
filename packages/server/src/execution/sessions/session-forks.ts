import { cutText } from '@solus/contracts/text-cut'
import { permissionsAllow } from '@solus/contracts/permissions'
import type { DigestTurn, SessionMergeBackPrompt } from '@solus/contracts/session-digest'
import type { SessionHistoryPage, SessionHistoryPageRequest, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { AgentId, SessionMeta, SessionRecord } from '@solus/contracts/types'
import { createResponseForkRecord, getSessionRecord, organizationOfSession } from '../../data/sessions/session-records'
import { sessionIdentityOf } from '../../data/sessions/session-identity'
import { resolveSessionLineageById, sessionIdOfThread } from '../../data/sessions/session-lineage'
import { emitSessionDigestChanged, readSessionDigests } from '../../data/sessions/session-digests'
import { forkActivityOf, treeRelation } from '../../data/sessions/session-tree-relations'
import { newActivity } from '../../data/activity/activity'
import { attributionOf, ownerKeyOf, type Actor, type AgentVia } from '../../admission/actor'
import { permissionsFor } from '../../admission/access-policy'
import { recordScopeOf, type RecordScope } from '../../admission/principal'
import { hostUserKey } from '../../host/host-user'
import { needsResponseFork, readResponseForkPage, savedResponseFork } from './response-fork'
import type { SessionRuntime } from '../session-runtime'

/**
 * Fork a session from one of its responses, and bring a fork's findings back to
 * its source. A person does this from a client (RPC `forkSessionFromResponse`
 * and `sessionMergeBackPrompt`); an agent does it with `fork_session`.
 */

/** How a caller reads other sessions: each read applies the caller's own access. */
export interface SessionReads {
  /** The session, as the caller reads it. It throws when the caller may not read it, and is null when this host does not know it. */
  sessionInfo(sessionId: string): Promise<SessionMeta | null>
  loadPage(request: SessionHistoryPageRequest): Promise<SessionHistoryPage>
}

export interface ResponseForkRequest {
  /** The session to fork. */
  sessionId: string
  /** The provider thread of the response; an unknown thread reads as the session's active one. */
  sourceThreadId: string
  /** The id of the new session. */
  targetSessionId: string
  /** The checkpoint of a saved response (`forkPointId`). */
  pointId: string
}

export interface ForkCaller {
  actor: Actor
  reads: SessionReads
  /** The agent session that asked, when an agent asked. */
  via?: AgentVia
}

/** Only a caller who may start a session on this host may fork one. */
export function mayFork(actor: Actor): boolean {
  return permissionsAllow(permissionsFor(actor.principal), 'host.sessions.start')
}

/**
 * Make a new session with the setup of its source and the history through the
 * chosen response. No turn runs: the first prompt to the fork starts the
 * provider from that checkpoint. A second request for the same fork answers
 * the saved one.
 */
export async function forkSessionFromResponse(
  runtime: SessionRuntime,
  request: ResponseForkRequest,
  caller: ForkCaller,
  /** Tells the clients about the new session. */
  announce?: (sessionId: string) => void,
): Promise<SessionRecord> {
  if (!mayFork(caller.actor)) throw new Error('You do not have permission to start a session on this host.')
  const sourceId = sessionIdOfThread(request.sessionId)
  const scope = recordScopeOf(caller.actor.principal)
  const ownerKey = ownerKeyOf(caller.actor) ?? hostUserKey()
  const saved = await savedFork(scope, request, sourceId, ownerKey)
  if (saved) return saved
  const origin = await forkOrigin(scope, sourceId, request.sourceThreadId, caller.reads)
  await readResponseForkPage(runtime, {
    sessionId: request.targetSessionId, sourceThreadId: origin.sourceThreadId, provider: origin.provider, cwd: origin.cwd,
    pointId: request.pointId, throughPointId: origin.inherited?.pointId, turnLimit: 20,
  })
  const fork = await saveFork(origin, request, caller, ownerKey)
  announce?.(fork.sessionId)
  await emitSessionDigestChanged(sourceId)
  return fork
}

/** The fork saved earlier for the same request, or null when the new session id is free. */
async function savedFork(scope: RecordScope, request: ResponseForkRequest, sourceId: string, ownerKey: string): Promise<SessionRecord | null> {
  const identity = await sessionIdentityOf(request.targetSessionId)
  if (!identity) return null
  const existing = await getSessionRecord(scope, request.targetSessionId)
  const fork = savedResponseFork(existing)
  if (existing && identity.ownerKey === ownerKey && fork?.sourceSessionId === sourceId && fork.pointId === request.pointId) return existing
  throw new Error('The fork session already exists.')
}

/** The source of a fork and where its history is read: a provider thread of the source, or the history that a source fork inherited. */
interface ForkOrigin {
  source: SessionRecord
  sourceThreadId: string
  provider: AgentId
  cwd: string
  inherited: ReturnType<typeof savedResponseFork>
}

async function forkOrigin(scope: RecordScope, sourceId: string, requestedThreadId: string, reads: SessionReads): Promise<ForkOrigin> {
  const source = await getSessionRecord(scope, sourceId)
  const lineage = resolveSessionLineageById(sourceId)
  const member = lineage?.members.find((item) => item.providerSessionId === requestedThreadId) ?? lineage?.active
  const inherited = lineage?.active.providerSessionId ? undefined : savedResponseFork(source)
  if (inherited && !await reads.sessionInfo(inherited.historySessionId ?? inherited.sourceSessionId)) {
    throw new Error('The fork source is no longer available.')
  }
  const cwd = member?.cwd || source?.cwd
  if (!source || !cwd) throw new Error('The source session is unavailable on this host.')
  return {
    source, cwd, inherited,
    provider: member?.provider ?? source.provider,
    sourceThreadId: member?.providerSessionId ?? inherited?.sourceThreadId ?? source.sessionId,
  }
}

/** Save the fork with the setup of its source and a `forked` activity. */
function saveFork(origin: ForkOrigin, request: ResponseForkRequest, caller: ForkCaller, ownerKey: string): Promise<SessionRecord> {
  const { source, provider, cwd, inherited } = origin
  const now = Date.now()
  const title = source.customTitle?.trim() || source.title?.trim() || 'Session'
  const activity = newActivity({ kind: 'session', id: request.targetSessionId }, attributionOf(caller.actor, caller.via), {
    kind: 'forked', sourceSessionId: source.sessionId, sourceTitle: title,
  }, now)
  return createResponseForkRecord({
    sessionId: request.targetSessionId, provider, projectPath: source.projectPath,
    title: `${title} fork`, customTitle: `${title} fork`, cwd, projectRoot: source.projectRoot,
    projectRemote: source.projectRemote, isWorktree: source.isWorktree, branch: source.branch,
    model: provider === source.provider ? source.model : null, reasoningEffort: source.reasoningEffort, lastActivityAt: now, place: source.place,
    startedBy: { kind: 'person', personKey: ownerKey, fork: {
      sourceSessionId: source.sessionId, sourceThreadId: origin.sourceThreadId, pointId: request.pointId,
      ...(inherited && { historySessionId: inherited.historySessionId ?? inherited.sourceSessionId }),
    } },
  }, { organizationId: source.organizationId, ownerKey }, activity)
}

/** Where the first turn of a fork starts: the provider thread and checkpoint of its source. */
export interface ResponseForkStart {
  provider: AgentId
  sourceThreadId: string
  pointId: string
}

/**
 * The start of a fork's first turn, while the fork has no provider thread of
 * its own; undefined for any other session. It refuses when the caller cannot
 * read the source, when another provider is asked for, or when the checkpoint
 * is gone.
 */
export async function responseForkStart(
  runtime: SessionRuntime,
  sessionId: string,
  caller: { actor: Actor; reads: Pick<SessionReads, 'sessionInfo'> },
  requestedProvider?: AgentId | null,
): Promise<ResponseForkStart | undefined> {
  if (!needsResponseFork(sessionId)) return undefined
  const record = await getSessionRecord(recordScopeOf(caller.actor.principal), sessionId)
  const fork = savedResponseFork(record)
  if (!fork || !record) return undefined
  if (!await caller.reads.sessionInfo(fork.historySessionId ?? fork.sourceSessionId)) {
    throw new Error('The fork source is no longer available.')
  }
  if (requestedProvider && requestedProvider !== record.provider) {
    throw new Error('Use the source provider for the first prompt in this fork.')
  }
  await readResponseForkPage(runtime, { sessionId, provider: record.provider, cwd: record.cwd, turnLimit: 20, ...fork })
  return { provider: record.provider, sourceThreadId: fork.sourceThreadId, pointId: fork.pointId }
}

/** The pages a fork point is looked for in: the latest completed response is in the newest turns. */
const LATEST_POINT_TURNS = 5

/** The latest completed response of a session that a fork can start from, or null when it has none. */
export async function latestForkPoint(session: Pick<SessionMeta, 'sessionId' | 'provider' | 'projectPath'>, reads: SessionReads): Promise<Pick<ResponseForkRequest, 'sourceThreadId' | 'pointId'> | null> {
  const page = await reads.loadPage({
    sessionId: session.sessionId, provider: session.provider, projectPath: session.projectPath,
    turnLimit: LATEST_POINT_TURNS, deferArtifactHtml: true,
  })
  const response = page.messages.findLast((message) => message.role === 'assistant' && !message.parentToolUseId && message.forkPointId)
  if (!response?.forkPointId) return null
  return { pointId: response.forkPointId, sourceThreadId: response.sourceSessionId ?? session.sessionId }
}

export function transcriptText(message: WireSessionLoadMessage): WireSessionLoadMessage[] {
  if (message.parentToolUseId || (message.role !== 'user' && message.role !== 'assistant') || !message.content.trim()) return []
  return [{ role: message.role, content: message.content, timestamp: message.timestamp, messageId: message.messageId }]
}

function completedTurn(turn: DigestTurn): boolean {
  return turn.settled && (turn.outcome === undefined || turn.outcome === 'completed')
}

/**
 * The prompt that brings a fork's findings to the session it was forked from:
 * the text of the fork's completed turns after the fork, cut to the newest part.
 */
export async function mergeBackPrompt(sessionId: string, reads: SessionReads): Promise<SessionMergeBackPrompt> {
  const scope = await organizationOfSession(sessionId)
  const fork = (await forkActivityOf(scope, sessionId)).find((entry) => entry.subject.id === sessionId)
  if (!fork) throw new Error('This session has no recorded fork source.')
  const sourceId = sessionIdOfThread(fork.sourceSessionId)
  await reads.sessionInfo(sourceId)
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
  const page = await reads.loadPage({
    sessionId,
    provider: child.provider,
    projectPath: child.projectPath,
    turnLimit: 12,
    deferArtifactHtml: true,
  })
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
}
