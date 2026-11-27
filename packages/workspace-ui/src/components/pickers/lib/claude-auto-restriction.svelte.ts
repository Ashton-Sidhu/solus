import type { ClaudeAutoModeTarget, ClaudeAutoRestriction } from '@solus/contracts/claude-auto-mode'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostFact } from '@solus/client-core/host-facts'
import { serverConnections } from '@solus/client-core/server-connections'

interface Target extends ClaudeAutoModeTarget {
  serverId: string
  connection: HostFact<ConnectionsServerInfo>
}

/** Read again when the picker opens. Drop answers for folders or connections it left. */
export function connectClaudeAutoRestriction(target: () => Target | undefined) {
  let answer = $state.raw<{ target: Target; restriction: ClaudeAutoRestriction | null } | null>(null)
  $effect(() => {
    const current = target()
    if (!current) return
    const api = serverConnections.apiFor(current.serverId)
    let active = true
    void api.claudeAutoModeRestriction({ cwd: current.cwd, sessionId: current.sessionId }).then((restriction) => {
      if (active && api === serverConnections.apiFor(current.serverId)) answer = { target: current, restriction }
    }).catch(() => {})
    return () => { active = false }
  })
  return {
    get current() {
      const current = target()
      const previous = answer?.target
      return current && previous && current.serverId === previous.serverId && current.cwd === previous.cwd
        && current.sessionId === previous.sessionId && current.connection === previous.connection
        ? answer?.restriction ?? null : null
    },
  }
}
