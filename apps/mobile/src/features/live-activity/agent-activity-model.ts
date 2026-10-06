import type { SessionStatus } from '@solus/contracts/types'
import type { AgentActivityPhase, AgentActivityProps, AgentActivityRowProps } from '../../widgets/AgentActivity'
import { threadKey, type SolusThreadShell } from '../threads/thread-directory'
import { resolveThreadListV2Status, threadTitle, type ThreadListV2Status } from '../threads/threadListV2'

/**
 * What the Live Activity shows, from the sessions this device knows: the
 * host's records and the live `session.statusChanged` values, read through the
 * same status rule as the thread list (`resolveThreadListV2Status`). T3 Code
 * builds this aggregate on its relay; Solus builds it in the app.
 *
 * Rows carry only a session's title, its project's name and a status: never a
 * prompt or a reply, because the card shows on the Lock Screen.
 */

/** ActivityKit drops a payload over 4 KB; the card shows at most five rows. */
const MAX_ROWS = 5
const MAX_TITLE = 60

const PHASE: { readonly [status in ThreadListV2Status]: { phase: AgentActivityPhase; status: string } } = {
  approval: { phase: 'waiting_for_approval', status: 'Approval' },
  input: { phase: 'waiting_for_input', status: 'Input' },
  working: { phase: 'running', status: 'Working' },
  // Settled turn, background work still running (Solus `background`).
  waiting: { phase: 'running', status: 'Background' },
  limited: { phase: 'limited', status: 'Rate limited' },
  failed: { phase: 'failed', status: 'Failed' },
  ready: { phase: 'completed', status: 'Done' },
}

const LIVE: ReadonlySet<ThreadListV2Status> = new Set(['approval', 'input', 'working', 'waiting', 'limited'])

export interface AgentActivityInput {
  readonly threads: readonly SolusThreadShell[]
  readonly liveStatus: ReadonlyMap<string, SessionStatus>
  readonly projectTitleOf: (thread: SolusThreadShell) => string
  /** Sessions this card has shown as live: once they settle they stay as Done or Failed. */
  readonly tracked: ReadonlySet<string>
  readonly now: number
}

export interface AgentActivityState {
  /** Null when there is nothing to show. */
  readonly props: AgentActivityProps | null
  readonly activeCount: number
  readonly tracked: ReadonlySet<string>
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine
}

/** The app path a row opens; the card prefixes the `solus://` scheme. */
export function agentActivityDeepLink(hostId: string, sessionId: string): string {
  return `/thread/${encodeURIComponent(hostId)}/${encodeURIComponent(sessionId)}`
}

export function deriveAgentActivity(input: AgentActivityInput): AgentActivityState {
  const updatedAt = new Date(input.now).toISOString()
  const tracked = new Set(input.tracked)
  const live: Array<{ thread: SolusThreadShell; status: ThreadListV2Status }> = []
  const settled: Array<{ thread: SolusThreadShell; status: ThreadListV2Status }> = []
  for (const thread of input.threads) {
    const key = threadKey(thread.hostId, thread.record.sessionId)
    const status = resolveThreadListV2Status(thread.record, input.liveStatus.get(key))
    if (LIVE.has(status)) {
      live.push({ thread, status })
      tracked.add(key)
    } else if (tracked.has(key)) {
      settled.push({ thread, status })
    }
  }
  if (live.length === 0 && settled.length === 0) return { props: null, activeCount: 0, tracked }
  // Newest first within each group; the card orders by attention itself.
  const newest = (a: { thread: SolusThreadShell }, b: { thread: SolusThreadShell }) => b.thread.record.lastActivityAt - a.thread.record.lastActivityAt
  const rows = [...live.sort(newest), ...settled.sort(newest)].slice(0, MAX_ROWS).map(({ thread, status }): AgentActivityRowProps => ({
    hostId: thread.hostId,
    sessionId: thread.record.sessionId,
    projectTitle: clip(input.projectTitleOf(thread)),
    threadTitle: clip(threadTitle(thread.record)),
    modelTitle: thread.record.model ?? '',
    ...PHASE[status],
    updatedAt,
    deepLink: agentActivityDeepLink(thread.hostId, thread.record.sessionId),
  }))
  return {
    props: {
      title: 'Solus',
      subtitle: live.length > 0 ? 'Agent work in progress' : 'Agent work completed',
      activeCount: live.length,
      updatedAt,
      activities: rows,
    },
    activeCount: live.length,
    tracked,
  }
}
