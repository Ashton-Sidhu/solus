import type { AgentScope, TreeSessionRow } from '@solus/client-core/session-tree'

/** One chip of the agent filter. */
export interface AgentFilterOption {
  scope: AgentScope
  label: string
  /** The chip's mark: a started session that works, or one that stopped working. Null for All and This session. */
  state: 'running' | 'done' | null
  /** Another host runs it: the chip names that it is a copy. */
  isRemote: boolean
}

/**
 * The agent filter's chips (docs/plans/session-digests.md): the whole tree,
 * the session alone, then each session it started, oldest started first.
 * Empty when the session started none: the filter then does not show.
 */
export function agentFilterOptions(sessionId: string, started: readonly TreeSessionRow[]): AgentFilterOption[] {
  if (started.length === 0) return []
  return [
    { scope: 'all', label: 'All', state: null, isRemote: false },
    { scope: sessionId, label: 'This session', state: null, isRemote: false },
    ...started.map((row): AgentFilterOption => ({
      scope: row.sessionId,
      label: row.title,
      state: row.isRunning ? 'running' : 'done',
      isRemote: row.isRemote,
    })),
  ]
}

/** The option Left and Right step to, wrapping at the ends. */
export function steppedOption(options: readonly AgentFilterOption[], current: AgentScope, step: -1 | 1): AgentFilterOption | null {
  if (options.length === 0) return null
  const index = Math.max(0, options.findIndex((option) => option.scope === current))
  return options[(index + step + options.length) % options.length]!
}
