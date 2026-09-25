import {
  ORCHESTRATION_LIMITS,
  clip,
  formatSessionOutput,
  type SessionOutput,
} from '@solus/contracts/session-exchange'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { TaskSessionLink } from '@solus/contracts/task-types'
import type { AgentId, NormalizedEvent, SessionMeta, SessionStatus } from '@solus/contracts/types'
import { extractPlanTitle } from '../agents/plan-text'
import { getChildSessions, getIndexedSession } from '../db/session-indexer'
import { listWorkRefsForSessions } from '../folio/works'
import { listPlanRefsForSessions } from '../plans/plan-index'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import { describePendingInput } from '../sessions/pending-input'
import { resolveSessionLineageById } from '../sessions/session-lineage'
import { taskWithAttempts } from '../tasks/task-sessions'

/**
 * The task view: everything that happened in one task, for the parent that
 * coordinates it. It covers every session working on the task — whoever
 * started it — with its status, what it waits on, its last message and what it
 * produced.
 *
 * It reads only durable records and live status, so after a restart a parent
 * still finds what its children produced even when a report was lost. Like a
 * report, it names outputs by id and never carries their content.
 */

export interface TaskViewReads {
  liveStatus(agentSessionId: string): SessionStatus | null
  pendingInputEvents(agentSessionId: string): NormalizedEvent[]
  /** The last `limit` messages of a session. */
  loadSessionTail(provider: AgentId, sessionId: string, projectPath: string | undefined, limit?: number): Promise<SessionLoadMessage[]>
  /** The link a reader opens the session with. */
  link(meta: Pick<SessionMeta, 'provider' | 'sessionId' | 'slug' | 'cwd' | 'serverId'>): string
}

interface ViewedSession {
  link: TaskSessionLink
  /** The provider thread the session runs on now. */
  thread: string
  meta: SessionMeta | null
}

export async function formatTaskSessions(taskId: string, reads: TaskViewReads): Promise<string | null> {
  const found = await taskWithAttempts(LOCAL_ORGANIZATION_ID, taskId)
  if (!found) return null
  const { task } = found
  const sessions: ViewedSession[] = found.attempts
    .filter((link) => link.role === 'working')
    .map((link) => {
      const thread = resolveSessionLineageById(link.sessionId)?.active.providerSessionId ?? link.sessionId
      return { link, thread, meta: getIndexedSession(thread) }
    })
    .sort((left, right) => (right.link.lastActivityAt ?? 0) - (left.link.lastActivityAt ?? 0))

  const shown = sessions.slice(0, ORCHESTRATION_LIMITS.taskViewSessions)
  const outputs = await outputsBySession(shown)
  const lastMessages = await Promise.all(shown.map((session) => lastMessage(session, reads)))

  const lines = [
    `Task ${task.id} [${task.status}] ${task.title}`,
    '',
    sessions.length ? `Sessions (${sessions.length}), most recent first:` : 'No sessions work on this task yet.',
  ]
  shown.forEach((session, index) => {
    lines.push('', ...sessionLines(session, reads, lastMessages[index] ?? null, outputs.get(session.thread) ?? []))
  })
  const rest = sessions.slice(shown.length)
  if (rest.length) {
    lines.push('', `${rest.length} older sessions:`)
    for (const session of rest) lines.push(`- ${sessionTitle(session, reads)}`)
  }
  return lines.join('\n')
}

function sessionTitle(session: ViewedSession, reads: TaskViewReads): string {
  const meta = session.meta
  const link = reads.link({
    provider: meta?.provider ?? session.link.provider ?? 'claude-code',
    sessionId: session.thread,
    slug: meta?.slug ?? session.link.sessionTitle ?? null,
    cwd: meta?.cwd ?? '',
    serverId: meta?.serverId,
  })
  return `${link} session id: ${session.thread}`
}

function sessionLines(
  session: ViewedSession,
  reads: TaskViewReads,
  last: string | null,
  outputs: SessionOutput[],
): string[] {
  const provider = session.meta?.provider ?? session.link.provider
  const model = session.meta?.model ?? session.link.model
  const status = reads.liveStatus(session.thread) ?? 'not running'
  const parent = session.meta?.delegation?.parentSessionId
  const lines = [
    `- ${sessionTitle(session, reads)}`,
    `  ${[provider && model ? `${provider}/${model}` : provider, status, parent ? `started by session ${parent}` : 'started by a person'].filter(Boolean).join(' · ')}`,
  ]
  const branch = session.meta?.branch ?? session.link.branch
  if (branch) lines.push(`  branch: ${branch}`)
  const waiting = waitingOn(reads.pendingInputEvents(session.thread))
  if (waiting) lines.push(`  waits on the user: ${waiting}`)
  if (last) lines.push(`  last message: ${JSON.stringify(last)}`)
  if (outputs.length) lines.push('  outputs:', ...outputs.map((output) => `  ${formatSessionOutput(output)}`))
  return lines
}

/** One line for what a session's turn waits on a person for. Never a plan's text. */
function waitingOn(events: readonly NormalizedEvent[]): string | null {
  const pending = describePendingInput(events)
  if (!pending) return null
  if (pending.kind === 'question') return `question ${JSON.stringify(clip(pending.questions[0]?.question ?? '', ORCHESTRATION_LIMITS.questionText))}`
  if (pending.kind === 'permission') return `permission to run ${JSON.stringify(clip(pending.toolName, ORCHESTRATION_LIMITS.title))}`
  return `plan ${JSON.stringify(clip(extractPlanTitle(pending.planContent), ORCHESTRATION_LIMITS.title))}${pending.planToolUseId ? ` plan=${pending.planToolUseId}` : ''}`
}

/** The session's last top-level reply, cut to the view's limit. */
async function lastMessage(session: ViewedSession, reads: TaskViewReads): Promise<string | null> {
  const provider = session.meta?.provider ?? session.link.provider
  if (!provider) return null
  const tail = await reads.loadSessionTail(provider, session.thread, session.meta?.projectPath || session.meta?.cwd || undefined, 8).catch(() => [])
  const reply = [...tail].reverse().find((message) => message.role === 'assistant' && !message.parentToolUseId && message.content.trim())
  return reply ? clip(reply.content, ORCHESTRATION_LIMITS.taskViewLastMessage) : null
}

/** What each session produced that the records know: works, plans, the
 *  sessions it started, its branch's pull request. Keyed by provider thread. */
async function outputsBySession(sessions: readonly ViewedSession[]): Promise<Map<string, SessionOutput[]>> {
  const byThread = new Map<string, SessionOutput[]>()
  const threadOf = new Map<string, string>()
  for (const session of sessions) {
    byThread.set(session.thread, [])
    threadOf.set(session.thread, session.thread)
    threadOf.set(session.link.sessionId, session.thread)
  }
  const ids = [...threadOf.keys()]
  const [works, plans] = await Promise.all([
    listWorkRefsForSessions(LOCAL_ORGANIZATION_ID, ids),
    listPlanRefsForSessions(LOCAL_ORGANIZATION_ID, ids),
  ])
  for (const plan of plans) {
    const thread = threadOf.get(plan.sessionId)
    if (thread) byThread.get(thread)!.push({ kind: 'plan', sessionId: thread, planToolUseId: plan.planToolUseId, title: plan.title })
  }
  for (const work of works) {
    const thread = threadOf.get(work.sessionId)
    if (thread) byThread.get(thread)!.push({ kind: 'work', workId: work.id, title: work.title, workType: work.type })
  }
  for (const child of getChildSessions([...byThread.keys()])) {
    const parent = child.delegation?.parentSessionId
    if (!parent) continue
    byThread.get(parent)?.push({ kind: 'session', sessionId: child.sessionId, title: child.slug || child.firstMessage || child.sessionId })
  }
  for (const session of sessions) {
    const pr = session.link.pr
    if (pr) byThread.get(session.thread)!.push({ kind: 'pull_request', number: pr.number, url: pr.url })
  }
  return byThread
}
