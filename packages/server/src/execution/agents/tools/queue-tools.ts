import { sessionQueueMutationSchema, type SessionQueueMutation, type SessionQueueSnapshot } from '@solus/contracts/session-queue'
import type { AgentTool } from './agent-tool'

export interface AgentQueueController {
  read(providerSessionId: string): SessionQueueSnapshot
  change(providerSessionId: string, mutation: SessionQueueMutation): Promise<SessionQueueSnapshot>
}
let controller: AgentQueueController | null = null
export function setAgentQueueController(next: AgentQueueController): void { controller = next }

export const readQueueAgentTool: AgentTool = {
  name: 'read_queue', description: 'Read this session’s ordered queue, saved model options, revisions, and held or failed entries.',
  inputFields: {}, requiresApproval: false,
  async execute(_input, context) {
    const id = context.sessionId()
    if (!id || !controller) return { ok: false, text: 'This session queue is unavailable.' }
    try { return { ok: true, text: JSON.stringify(controller.read(id)) } }
    catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) } }
  },
}

export const changeQueueAgentTool: AgentTool = {
  name: 'change_queue',
  description: 'Edit, remove, reorder, or steer a queued prompt, or queue a provider/model switch in this session. Read the current revision with read_queue first. Only the user can resume a queue held after restart or failure.',
  inputFields: { mutation: sessionQueueMutationSchema }, requiresApproval: false,
  async execute(input, context) {
    const id = context.sessionId()
    const parsed = sessionQueueMutationSchema.safeParse(input.mutation)
    if (!id || !controller || !parsed.success) return { ok: false, text: 'This queue operation is unavailable or invalid.' }
    if (parsed.data.kind === 'resume') return { ok: false, text: 'Only the user can resume a held queue.' }
    try { return { ok: true, text: JSON.stringify(await controller.change(id, parsed.data)) } }
    catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) } }
  },
}
