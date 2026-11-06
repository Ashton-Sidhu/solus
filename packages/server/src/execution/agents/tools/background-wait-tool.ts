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
  "Set whether a running command keeps this session in background after your turn ends. For Claude shells and Monitors, call with waiting=true before ending your turn to wait for their result; unmarked work does not hold. Codex commands hold by default: use waiting=false only for a dev server, watcher, or other service you intend to leave running. Use waiting=true to restore the wait. For Codex task_ids, use the terminal session ID returned by exec_command or the command item ID. This does not stop the command. Sub-agents always hold and cannot be unmarked. IDs that are not running come back as unmatched."

const fields = {
  task_ids: z.array(z.string().trim().min(1)).min(1).max(20).describe('The IDs of the background tasks, as shown when each one started.'),
  waiting: z.boolean().optional().describe('false removes the mark. Defaults to true.'),
}
const inputSchema = z.object(fields)

export function awaitBackgroundTasks(input: z.output<typeof inputSchema>, provider: AgentId, sessionId: string | undefined): AgentToolResult {
  if (provider !== 'claude-code' && provider !== 'codex') return { ok: false, text: 'background_wait is unsupported for this provider. Claude and Codex sessions support it.' }
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
