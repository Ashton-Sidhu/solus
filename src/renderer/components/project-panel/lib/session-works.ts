import type { Message, Work } from '../../../../shared/types'

/** A work the active session touched, with the strongest action seen. */
export interface SessionWork {
  work: Work
  action: 'created' | 'updated'
}

/** Matches both Claude (`mcp__solus__update_work`) and Codex (`update_work`). */
function isUpdateWorkTool(name: string | undefined): boolean {
  return !!name && name.endsWith('update_work')
}

function workIdFromToolInput(toolInput: string | undefined): string {
  if (!toolInput) return ''
  try {
    const input = JSON.parse(toolInput) as { work_id?: unknown }
    return typeof input.work_id === 'string' ? input.work_id : ''
  } catch {
    return ''
  }
}

function linkedToSession(work: Work, agentSessionId: string | null): boolean {
  if (!agentSessionId) return false
  return work.sessionIds?.includes(agentSessionId) || work.sessionId === agentSessionId
}

/**
 * The works created or updated during the active session, derived from the same
 * `messages` that drive the conversation — so this is correct live and after a
 * history reload without a second code path.
 *
 * Created works are sourced from `workRef` messages plus the store's session
 * linkage (truncation-proof: `create_work` tags the work with the session id).
 * Updated works come from `update_work` tool rows, which carry the `work_id`.
 * `created` outranks `updated`; only works still present in the store are kept,
 * so every row has live metadata and a working open target.
 */
export function sessionWorks(messages: Message[], works: Record<string, Work>, agentSessionId: string | null): SessionWork[] {
  const actions = new Map<string, 'created' | 'updated'>()

  // Created via persisted session linkage (survives message truncation).
  for (const w of Object.values(works)) {
    if (linkedToSession(w, agentSessionId)) actions.set(w.id, 'created')
  }

  for (const m of messages) {
    if (m.workRef?.workId) {
      actions.set(m.workRef.workId, 'created')
    } else if (m.role === 'tool' && isUpdateWorkTool(m.toolName)) {
      const id = workIdFromToolInput(m.toolInput)
      // Created outranks updated — a work made this session stays "Created".
      if (id && actions.get(id) !== 'created') actions.set(id, 'updated')
    }
  }

  const result: SessionWork[] = []
  for (const [id, action] of actions) {
    const work = works[id]
    if (work) result.push({ work, action })
  }
  return result.sort((a, b) => b.work.updatedAt.localeCompare(a.work.updatedAt))
}
