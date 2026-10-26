import { z } from 'zod'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { getSessionController } from './session-tools'
import type { AgentId } from '@solus/contracts/types'

/**
 * `background_wait` (docs/background-work.md): the agent marks the background
 * shells or Monitors it waits on. Only marked work keeps the session in
 * 'background'; work it leaves running, such as a dev server, does not.
 */

const DESCRIPTION =
  "Keep this session working, and the user not told it is done, while you wait for background work. Start a background command or Monitor first. Call this before you end your turn if you will act on its result when it wakes you. In task_ids, give the ID shown when the task started. The session stays working until the task ends. Do not mark work you leave running, such as a dev server or a watcher: unmarked commands and Monitors never keep the session working. Sub-agents always do, so do not mark them. Pass waiting=false to remove the mark; this does not stop the task. IDs that are not running come back as unmatched and change nothing. Only Claude sessions support this tool."

const fields = {
  task_ids: z.array(z.string().trim().min(1)).min(1).max(20).describe('The IDs of the background tasks, as shown when each one started.'),
  waiting: z.boolean().optional().describe('false removes the mark. Defaults to true.'),
}
const inputSchema = z.object(fields)

export function awaitBackgroundTasks(input: z.output<typeof inputSchema>, provider: AgentId, sessionId: string | undefined): AgentToolResult {
  if (provider !== 'claude-code') return { ok: false, text: 'background_wait is unsupported for this provider. Only Claude sessions support it.' }
  if (!sessionId) return { ok: false, text: 'background_wait needs a calling session, and this session has no id yet.' }
  const result = getSessionController()?.awaitBackgroundTasks?.(sessionId, input.task_ids, input.waiting ?? true)
  if (!result) return { ok: false, text: 'background_wait needs a live session. This run is not one.' }
  return { ok: true, text: JSON.stringify(result) }
}

export const backgroundWaitAgentTool: AgentTool<typeof fields> = {
  name: 'background_wait',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  execute: async (args, context) => awaitBackgroundTasks(inputSchema.parse(args), context.provider, context.sessionId()),
}
