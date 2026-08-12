import type { Message, TodoItem } from '../../../../shared/types'
import { progressFromMessages, progressTodosFromTool } from '../../../contexts/workspace/session.utils'

export type SubagentInput = {
  subagent_type?: string
  description?: string
  prompt?: string
  task?: string
  instructions?: string
  model?: string
  reasoning_effort?: string
  agent_thread_id?: string
  agent_path?: string
}

export function parseSubagentInput(toolInput: string | undefined): SubagentInput {
  const input = toolInput?.trim()
  if (!input) return {}
  try {
    const parsed = JSON.parse(input)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as SubagentInput
      : { prompt: input }
  } catch {
    return { prompt: input }
  }
}

export function subagentInputText(input: SubagentInput): string {
  for (const value of [input.prompt, input.task, input.instructions]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// A sub-tool's toolInput carries whole file bodies (Write/Edit) and can still
// change while running (Codex patch updates replace it). Parse each sub message
// at most once, cached on the message object, and never while it's running —
// the cache would otherwise pin a stale parse. Module-scoped WeakMap so every
// reader of a sub-transcript shares one parse per message.
const subParseCache = new WeakMap<Message, object | null>()

export function parseSubInput(m: Message): object | null {
  if (!m.toolInput || m.toolStatus === 'running') return null
  const cached = subParseCache.get(m)
  if (cached !== undefined) return cached
  let parsed: object | null = null
  try {
    const value: unknown = JSON.parse(m.toolInput)
    parsed = value !== null && typeof value === 'object' ? value : null
  } catch {}
  subParseCache.set(m, parsed)
  return parsed
}

/**
 * The sub-agent's todo list. Live runs get it from the parented `progress` event
 * the reducer lands on `subTodos`. A reloaded transcript has no events, so fall
 * back to the last todo-writing tool in the replayed sub-transcript — the same
 * list, read from the call that wrote it.
 */
export function subagentTodos(message: Message): TodoItem[] {
  if (message.subTodos?.length) return message.subTodos
  return progressFromMessages(message.subMessages ?? [])?.todos ?? []
}

/**
 * Calls the agent has made since it last rewrote its plan — how much work the
 * step in flight has taken. A step has no denominator of its own, so this is the
 * only honest measure of one, and it is counted from the plan write rather than
 * from dispatch so a long run doesn't make every step look finished.
 */
export function callsOnCurrentStep(message: Message): number {
  const subs = message.subMessages ?? []
  let calls = 0
  for (let i = subs.length - 1; i >= 0; i--) {
    const m = subs[i]
    if (progressTodosFromTool(m.toolName, m.toolInput)) break
    if (m.role === 'tool') calls++
  }
  return calls
}
