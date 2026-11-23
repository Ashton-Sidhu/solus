import { agentActivityOfTool, type AgentActivity } from '@solus/contracts/agent-activity'
import { DOT_MARK_FOR_ACTIVITY, type DotMarkName } from '@solus/client-core/dot-marks'
import type { Message } from '@solus/contracts/types'
import type { GlyphStatus } from '../../session/lib/task-list'
import type { SubagentRowState } from './subagent-group'

/**
 * The flat agent row (T3 Code's subagent link): a round provider avatar, the
 * title, one detail line, the state mark, the elapsed time, and a chevron.
 * The same row carries a sub-agent and a session another agent started.
 */

/** How an agent stands: what the Agents card groups by and what Stop acts
 *  on. Every in-flight state is `live`. */
export type AgentStanding = 'live' | 'done' | 'failed' | 'stopped'

/** The state mark in the row's trailing slot, with the grammar of the sidebar
 *  (docs/plans/session-state-marks.md): a dot mark while the agent works, a
 *  line glyph when a person must act or the agent is done. */
export type AgentStateMark =
  | { kind: 'dot'; mark: DotMarkName }
  | { kind: 'glyph'; status: GlyphStatus; limitResetsAt?: number }

export interface AgentLinkStatus {
  standing: AgentStanding
  /** Null when the row shows no mark: a session that closed itself. */
  mark: AgentStateMark | null
  /** One or two words: `Running`, `Completed`, `Failed`. The tooltip and
   *  `aria-label` say it; the detail line says it when there is no detail. */
  label: string
}

/** The dot mark of an agent activity. A running turn with no known activity works. */
export function dotMarkOfActivity(activity: AgentActivity | null | undefined): DotMarkName {
  return activity ? DOT_MARK_FOR_ACTIVITY[activity] : 'working'
}

/** Whether the row keeps its elapsed time beside the mark. The marks of a
 *  running turn and of a settled agent do. Starting and Offline have no turn
 *  to date, and Input, Approval, and Limited spend the slot on their word. */
export function agentMarkShowsElapsed(mark: AgentStateMark | null): boolean {
  if (!mark) return true
  if (mark.kind === 'dot') return mark.mark !== 'starting' && mark.mark !== 'offline'
  return mark.status === 'finished' || mark.status === 'error'
}

/** One line of a markdown result: drop list bullets, code ticks, and link targets. */
export function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The dot mark of the step a running sub-agent is on now. It reads only the
 * last row of the nested transcript, so a streamed token costs one read, not a
 * walk. The host drops a sub-agent's thinking, so a settled last row (a tool
 * that answered, a text block that ended) is the agent thinking about its next
 * step, as the main thread reads the time after a tool result. With no nested
 * transcript, a backgrounded agent's heartbeat names its last tool.
 */
export function subagentDotMark(message: Message): DotMarkName {
  const last = message.subMessages?.at(-1)
  if (last) {
    if (last.role === 'tool' && last.toolStatus === 'running') return dotMarkOfActivity(agentActivityOfTool(last.toolName))
    if (last.role === 'assistant' && last.isStreaming) return 'writing'
    return 'thinking'
  }
  const lastToolName = message.backgroundTaskProgress?.lastToolName
  return lastToolName ? dotMarkOfActivity(agentActivityOfTool(lastToolName)) : 'working'
}

/** A sub-agent row's standing, mark, and word. `liveMark` is the dot mark of a
 *  running agent's step (`subagentDotMark`). */
export function subagentLinkStatus(row: { state: SubagentRowState; liveMark: DotMarkName | null }): AgentLinkStatus {
  switch (row.state) {
    case 'running':
      return { standing: 'live', mark: { kind: 'dot', mark: row.liveMark ?? 'working' }, label: 'Running' }
    case 'done':
      return { standing: 'done', mark: { kind: 'glyph', status: 'finished' }, label: 'Completed' }
    case 'failed':
      return { standing: 'failed', mark: { kind: 'glyph', status: 'error' }, label: 'Failed' }
  }
}

/**
 * What a group's agents are doing, counted in the order a reader scans them:
 * what still runs first, then outcomes. `2 working · 1 done`.
 */
export function subagentStatusLine(states: SubagentRowState[]): string {
  const working = states.filter((state) => state === 'running').length
  const failed = states.filter((state) => state === 'failed').length
  const done = states.length - working - failed
  return [
    working > 0 ? `${working} working` : '',
    done > 0 ? `${done} done` : '',
    failed > 0 ? `${failed} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
