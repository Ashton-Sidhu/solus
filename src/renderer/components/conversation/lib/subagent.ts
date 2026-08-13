import type { Message, TodoItem } from '../../../../shared/types'
import { progressFromMessages, progressTodosFromTool } from '../../../contexts/workspace/session.utils'
import { z } from 'zod'

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

const subagentInputSchema = z.object({
  subagent_type: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  task: z.string().optional(),
  instructions: z.string().optional(),
  model: z.string().optional(),
  reasoning_effort: z.string().optional(),
  agent_thread_id: z.string().optional(),
  agent_path: z.string().optional(),
})

export function parseSubagentInput(toolInput: string | undefined): SubagentInput {
  const input = toolInput?.trim()
  if (!input) return {}
  try {
    const parsed = subagentInputSchema.safeParse(JSON.parse(input))
    return parsed.success ? parsed.data : { prompt: input }
  } catch {
    return { prompt: input }
  }
}

export function subagentInputText(input: SubagentInput): string {
  for (const value of [input.prompt, input.task, input.instructions]) {
    if (value?.trim()) return value.trim()
  }
  return ''
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
