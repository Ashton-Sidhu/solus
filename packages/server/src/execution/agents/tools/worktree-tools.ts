import { z } from 'zod'
import type { AgentTool } from './agent-tool'
import { HOST_ACTOR } from '../../../admission/actor'
import { resolveHomePath } from '../../../platform/paths'
import { sessionSettings } from '../../sessions/session-settings'
import type { WorktreeMover } from '../../sessions/worktree-move'

/** Wired once the host boots (`boot-server.ts`). */
let worktreeMover: WorktreeMover | null = null
export function setWorktreeMover(mover: WorktreeMover): void {
  worktreeMover = mover
}

const MOVE_TO_WORKTREE_DESC = [
  'Move this session into a git worktree. Solus binds the session to its directory: the diff, Git status, changed files, snapshots, and branch name follow the move. Use this, not `git worktree add` and `cd`, when you want an isolated checkout.',
  'Without `path`, Solus creates a new worktree from `base_branch` (default: the session\'s target branch), and names the branch from `branch_name` or `purpose` with the user\'s branch-naming settings. With `path`, the session moves into that existing worktree of the same repository.',
  'This turn keeps its process in the old directory. For the rest of this turn, work in the worktree path the result gives you (absolute paths, or `cd` into it in each shell command). From the next turn, you start in the worktree.',
].join('\n\n')

const moveToWorktreeFields = {
  path: z.string().optional().describe('An existing worktree of this repository to move into. Omit to create a new worktree.'),
  base_branch: z.string().optional().describe('New worktree only: the branch to start from.'),
  branch_name: z.string().optional().describe('New worktree only: a short name for the new branch. The branch-naming settings apply.'),
  purpose: z.string().optional().describe('New worktree only: one sentence about the work, used to name the branch when branch_name is absent.'),
}

const moveToWorktreeInput = z.object(moveToWorktreeFields)

export const moveToWorktreeAgentTool: AgentTool = {
  name: 'move_to_worktree',
  description: MOVE_TO_WORKTREE_DESC,
  inputFields: moveToWorktreeFields,
  requiresApproval: false,
  execute: async (rawInput, context) => {
    const parsed = moveToWorktreeInput.safeParse(rawInput)
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
    const input = parsed.data
    const sessionId = context.solusSessionId()
    if (!sessionId) return { ok: false, text: 'move_to_worktree needs a Solus session. A sub-agent cannot move its parent session.' }
    if (!worktreeMover) return { ok: false, text: 'Worktree moves are not available on this host.' }
    if (input.path && (input.base_branch || input.branch_name)) {
      return { ok: false, text: 'Give either path (an existing worktree) or base_branch/branch_name (a new worktree), not both.' }
    }
    const result = await worktreeMover.move({
      sessionId,
      cwd: resolveHomePath(context.cwd),
      target: input.path
        ? { kind: 'existing', path: input.path }
        : { kind: 'new', baseBranch: input.base_branch, branchName: input.branch_name, namePrompt: input.purpose },
      actor: HOST_ACTOR,
      preferences: sessionSettings(sessionId)?.preferences,
      signal: context.abortSignal,
    })
    if (!result.success || !result.gitContext?.worktreePath) return { ok: false, text: result.error ?? 'The move failed.' }
    const branch = result.gitContext.branch ?? result.gitContext.detachedHeadSha ?? 'a detached HEAD'
    return {
      ok: true,
      text: `Moved this session into the worktree at ${result.gitContext.worktreePath} on ${branch}. For the rest of this turn, work in that path. From the next turn, you start there.`,
    }
  },
}
