import type { SubagentRow } from './subagent-group'

/** Three segments places a file. The worktree prefix above it is identical for
 *  every row in the session. */
const PATH_SEGMENTS = 3

/**
 * The live target, trimmed to the segments that place the file. A Grep pattern
 * or a Bash command is left whole: slicing it into directories would invent a
 * structure it doesn't have.
 */
export function subagentTargetPath(target: string): string {
  const trimmed = target.trim()
  if (!trimmed.includes('/') || /\s/.test(trimmed)) return trimmed
  return trimmed.split('/').filter(Boolean).slice(-PATH_SEGMENTS).join('/')
}

/**
 * The sub-agent row's detail line: the step in flight and what it is on while
 * the agent runs ("Reading renderer/panels/HostPicker.svelte"), its answer once
 * it lands, or the reason it stopped.
 */
export function subagentDetail(row: Pick<SubagentRow, 'state' | 'activity' | 'target'>): string {
  const activity = row.activity.trim()
  if (row.state !== 'running') return activity
  const target = row.target ? subagentTargetPath(row.target) : ''
  return [activity, target].filter(Boolean).join(' ')
}
