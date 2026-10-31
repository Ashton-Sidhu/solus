import { z } from 'zod'
import type { AgentTool } from './agent-tool'
import { startSessionFields, launchSession } from './session-tools'
import { Task } from '../../../data/tasks/task'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { resolveHomePath } from '../../../platform/paths'
import { resolveRepoRoot } from '../../../git/git-helpers'
import { getHeadCommit } from '../../../git/worktree-manager'

const { task: _membership, task_id: _taskId, ...sessionFields } = startSessionFields
const fields = {
  ...sessionFields,
  host: sessionFields.host.describe('Host id or name from list_agent_targets. Omit for this host. Remote cwd, provider, and model must exist on that host.'),
  task_id: z.string().min(1).nullable().optional().describe('Existing Solus task to join. Omit to inherit the parent’s task locally; null keeps the child unlinked. Remote children cannot join a task yet.'),
  isolation: z.enum(['shared', 'worktree']).default('shared').describe('Shared uses cwd or the parent checkout. Worktree creates a separate checkout from the parent commit, or worktree_base_branch. On another host, name cwd and worktree_base_branch.'),
  report: z.boolean().default(true).describe('Wake the parent with notices and the final report. Defaults to true.'),
}
const schema = z.object(fields).strict()

export const delegateTaskAgentTool: AgentTool = {
  name: 'delegate_task',
  description: 'Start one durable child agent on this or another provider. Give the full brief in prompt; it gets no parent history. Async by default; wait_seconds waits without cancelling on timeout. Choose isolation=worktree for separate edits or a PR. Keep the session and exchange IDs. Reports wake you; do not poll. Follow up with send_session, read with read_session_exchange, stop with stop_session. User questions and permissions stay on the child’s card.',
  inputFields: fields,
  strictInput: true,
  requiresApproval: false,
  alwaysLoad: true,
  execute: async (args, context) => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) return { ok: false, text: `Invalid arguments for delegate_task: ${z.prettifyError(parsed.error)}` }
    const sessionId = context.sessionId()
    if (!sessionId) return { ok: false, text: 'delegate_task requires an initialized parent session.' }
    try {
      const { isolation, task_id, ...input } = parsed.data
      if (input.host && task_id) return { ok: false, text: 'Remote children cannot join a Solus task yet.' }
      const taskId = task_id === undefined && !input.host ? (await Task.forSession(ANY_ORGANIZATION, sessionId))?.id : task_id
      const workspaceError = await prepareWorkspace(input, isolation, context.cwd)
      if (workspaceError) return { ok: false, text: workspaceError }
      return await launchSession({ ...input, task: taskId ? 'attempt' : 'none', task_id: taskId ?? undefined }, {
        ctx: { agentProvider: context.provider, cwd: resolveHomePath(context.cwd), sessionId },
      }, false)
    } catch (error) {
      return { ok: false, text: `delegate_task failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

/** Bind the child to a checkout before launch; a parent worktree starts a sibling. */
async function prepareWorkspace(
  input: Pick<z.output<typeof schema>, 'cwd' | 'host' | 'worktree_base_branch'>,
  isolation: 'shared' | 'worktree', callerCwd: string,
): Promise<string | undefined> {
  if (isolation === 'shared' && input.worktree_base_branch) return 'worktree_base_branch requires isolation=worktree.'
  if (isolation === 'worktree') {
    if (input.host) {
      if (!input.cwd || !input.worktree_base_branch) return 'An isolated remote child needs cwd and worktree_base_branch on that host.'
    } else {
      const cwd = resolveHomePath(input.cwd?.trim() || callerCwd)
      const [root, commit] = await Promise.all([resolveRepoRoot(cwd), getHeadCommit(cwd)])
      if (!root || !commit) return 'An isolated child needs a Git repository with a commit.'
      input.cwd = root
      input.worktree_base_branch ??= commit
    }
  }
  return undefined
}
