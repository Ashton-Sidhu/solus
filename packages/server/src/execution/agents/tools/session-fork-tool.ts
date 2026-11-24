import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SessionMeta, SessionRecord } from '@solus/contracts/types'
import { actorFor, type Actor } from '../../../admission/actor'
import type { Principal } from '../../../admission/principal'
import { assertToolMay, workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import type { SessionRuntime } from '../../session-runtime'
import { forkSessionFromResponse, latestForkPoint, mayFork, mergeBackPrompt, type SessionReads } from '../../sessions/session-forks'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import { getSessionController, getSessionOrchestration, sessionLink } from './session-tools'

/**
 * `fork_session`: an agent forks a session from a completed response, or brings
 * a fork's findings back to its source, as a person does from a client. It
 * acts for the person the calling session works for, on this host only.
 */

/** What the tool needs from the host: `SessionController.fork`, wired when the host boots (`boot-server.ts`). */
export interface SessionForkHost {
  runtime: SessionRuntime
  /** Session reads with the access of one person. */
  readsFor(principal: Principal): SessionReads
  /** Tells the clients about a new fork. */
  announce(sessionId: string): void
}

const DESCRIPTION =
  "fork: copy a session (default: this one) through point_id into a new session; no turn runs until send_session. merge_back: bring a fork's findings to its source; to this session they come back as the result."

const fields = {
  action: z.enum(['fork', 'merge_back']),
  session_id: z.string().trim().min(1).optional().describe('fork: the session to fork. merge_back: the fork. Defaults to this session.'),
  point_id: z.string().trim().min(1).max(256).optional().describe('fork only. Default: the latest completed response.'),
}
const inputSchema = z.object(fields)
type ForkInput = z.output<typeof inputSchema>

/** A client opens a session by its id; the working directory only helps it open faster. */
function linkOf(meta: SessionMeta | null, record: Pick<SessionRecord, 'sessionId' | 'provider'>): string {
  return sessionLink(meta ?? { provider: record.provider, sessionId: record.sessionId, slug: null, cwd: '', serverId: undefined })
}

export async function runSessionFork(input: ForkInput, context: Pick<AgentToolContext, 'provider'> & { callerSessionId: string | undefined }): Promise<AgentToolResult> {
  const forkHost = getSessionController()?.fork
  if (!forkHost) return { ok: false, text: 'fork_session is not available on this host.' }
  const sessionId = input.session_id ?? context.callerSessionId
  if (!sessionId) return { ok: false, text: 'fork_session needs a session_id: this session has no id yet.' }
  if (input.action === 'merge_back' && input.point_id) return { ok: false, text: 'point_id is for fork only.' }
  // Each admitted turn runs its tools as its person (`credentialScopedAgentTools`); with none, the tool does not act.
  const principal = workspaceToolAuthority()
  if (!principal) return { ok: false, text: 'fork_session needs the person this session works for.' }
  const actor = actorFor(principal)
  const reads = forkHost.readsFor(actor.principal)
  try {
    return input.action === 'fork'
      ? await fork(forkHost, sessionId, input.point_id, actor, reads, context)
      : await mergeBack(forkHost, sessionId, actor, reads, context.callerSessionId)
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

async function fork(
  host: SessionForkHost,
  sessionId: string,
  pointId: string | undefined,
  actor: Actor,
  reads: SessionReads,
  context: Pick<AgentToolContext, 'provider'> & { callerSessionId: string | undefined },
): Promise<AgentToolResult> {
  if (!mayFork(actor)) return { ok: false, text: 'The person this session works for may not start a session on this host.' }
  const source = await reads.sessionInfo(sessionId)
  if (!source) return { ok: false, text: `Session ${sessionId} not found on this host.` }
  // A person forks a session they may prompt; so does the agent that works for them.
  await assertToolMay('forkSessionFromResponse', source.sessionId)
  const point = pointId ? { pointId, sourceThreadId: source.sessionId } : await latestForkPoint(source, reads)
  if (!point) return { ok: false, text: `${sessionLink(source)} has no completed response to fork from yet.` }
  const via = context.callerSessionId ? { sessionId: context.callerSessionId, provider: context.provider } : undefined
  const record = await forkSessionFromResponse(host.runtime, {
    sessionId: source.sessionId, targetSessionId: randomUUID(), ...point,
  }, { actor, reads, via }, host.announce)
  const forked = await reads.sessionInfo(record.sessionId).catch(() => null)
  return {
    ok: true,
    text: `Forked ${sessionLink(source)} into ${linkOf(forked, record)} (session id ${record.sessionId}). No turn runs yet. Use send_session with this session id to start work in it.`,
  }
}

async function mergeBack(host: SessionForkHost, sessionId: string, actor: Actor, reads: SessionReads, callerSessionId: string | undefined): Promise<AgentToolResult> {
  const merge = await mergeBackPrompt(sessionId, reads)
  if (merge.target.runnerHostId) {
    return { ok: false, text: `The fork source "${merge.target.title}" runs on another host. fork_session merges back on this host only.` }
  }
  // A session cannot send a message to itself, so the caller gets the findings.
  if (merge.target.sessionId === callerSessionId) {
    return { ok: true, text: `This session is the fork source. The findings of the fork follow; use them in your work.\n\n${merge.prompt}` }
  }
  const orchestration = getSessionOrchestration()
  if (!orchestration) return { ok: false, text: 'fork_session cannot send messages: no session orchestrator is wired.' }
  if (!callerSessionId) return { ok: false, text: 'fork_session cannot send messages before this session has an id.' }
  await assertToolMay('promptHeadlessSession', merge.target.sessionId)
  const sent = await orchestration.send(callerSessionId, merge.target.sessionId, { prompt: merge.prompt, delivery: 'queue', notify: false, waitMs: 0 })
  const target = await reads.sessionInfo(merge.target.sessionId).catch(() => null)
  const link = target ? sessionLink(target) : `"${merge.target.title}"`
  const verb = sent.disposition === 'queued' ? 'Queued' : 'Sent'
  return { ok: true, text: `${verb} the findings of the fork to its source ${link} (session id ${merge.target.sessionId}). The message asks it to summarize them for future work. No report comes back.` }
}

export const forkSessionAgentTool: AgentTool<typeof fields> = {
  name: 'fork_session',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  // An unknown field must fail: dropped, it could leave no session_id, and the tool would act on this session.
  strictInput: true,
  execute: async (args, context) => runSessionFork(inputSchema.parse(args), { provider: context.provider, callerSessionId: context.sessionId() }),
}
