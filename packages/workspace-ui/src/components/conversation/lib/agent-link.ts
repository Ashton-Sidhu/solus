import type { SubagentRowState } from './subagent-group'

/**
 * The flat agent row (T3 Code's subagent link): a round provider avatar with a
 * status dot, the title, one detail line, the elapsed time, and a chevron. The
 * same row carries a sub-agent and a session another agent started.
 */

/** The status dot. Every in-flight state is `live`; only settled states differ. */
export type AgentLinkTone = 'live' | 'done' | 'failed' | 'idle'

export interface AgentLinkStatus {
  tone: AgentLinkTone
  /** One or two words: `Running`, `Completed`, `Failed`. */
  label: string
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

const SUBAGENT_STATUS = {
  running: { tone: 'live', label: 'Running' },
  done: { tone: 'done', label: 'Completed' },
  failed: { tone: 'failed', label: 'Failed' },
} satisfies Record<SubagentRowState, AgentLinkStatus>

export function subagentLinkStatus(state: SubagentRowState): AgentLinkStatus {
  return SUBAGENT_STATUS[state]
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
