// Shaping for the rail's Subagents card: every sub-agent the session has
// dispatched, live ones first, each a row that opens the sub-agent pane. Per
// the renderer rules the .svelte holds markup and thin handlers; the ordering
// and the header reading live here.
import type { Message } from '@solus/contracts/types'
import {
  subagentGroupSummary,
  subagentRow,
  type SubagentModelFallback,
  type SubagentRow,
} from '../../conversation/lib/subagent-group'

/** The sub-agents in a transcript. Presence of `subMessages` is what makes a
 *  tool call a sub-agent — the same rule the conversation uses to draw one. */
export function sessionSubagents(messages: Message[]): Message[] {
  return messages.filter((message) => message.role === 'tool' && !!message.subMessages)
}

export interface RailSubagentList {
  /** Running agents first — they are what the rail is watched for — then the
   *  settled ones, newest first, so the report just landed is nearest the top. */
  rows: SubagentRow[]
  running: number
  /** The header's one reading: "2 running" · "3 done · 1 failed" · "5 done".
   *  Empty when there is nothing to count. */
  detail: string
}

export function railSubagentList(
  messages: Message[],
  now: number,
  fallback: SubagentModelFallback,
): RailSubagentList {
  const rows = messages.map((message) => subagentRow(message, now, fallback))
  const ordered = rows
    .map((row, i) => ({ row, startedAt: messages[i].timestamp }))
    .sort(
      (a, b) =>
        Number(b.row.state === 'running') - Number(a.row.state === 'running') ||
        b.startedAt - a.startedAt,
    )
    .map(({ row }) => row)
  const summary = subagentGroupSummary(messages, rows, now, '')
  return {
    rows: ordered,
    running: summary.running,
    detail: rows.length > 0 ? summary.chip : '',
  }
}

/** The row's hover: the task, then what the agent is doing or what it came
 *  back with — the one line the rail has no room to print. */
export function railSubagentTooltip(row: SubagentRow): string {
  const state =
    row.state === 'running' ? 'Running' : row.state === 'failed' ? 'Failed' : 'Returned'
  const detail = [row.activity, row.target].filter(Boolean).join(' ')
  return detail ? `${row.name}\n${state} · ${detail}` : `${row.name}\n${state}`
}
