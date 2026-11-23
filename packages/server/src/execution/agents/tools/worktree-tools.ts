import { z } from 'zod'
import type { BranchRef } from '@solus/contracts/git-types'
import type { AgentTool } from './agent-tool'
import { HOST_ACTOR, type Actor } from '../../../admission/actor'
import { runAsync } from '../../../git/exec'
import { listBranchRefs } from '../../../git/worktree-manager'
import { resolveHomePath } from '../../../platform/paths'
import { sessionSettings } from '../../sessions/session-settings'
import type { AgentMoveResult, WorktreeMover, WorktreeStatus } from '../../sessions/worktree-move'

/** Wired once the host boots (`boot-server.ts`). */
let worktreeMover: WorktreeMover | null = null
/** Whom a session's turn acts for, so the move names its branch as that person (plans/019). */
let actorOfSession: (sessionId: string) => Actor | undefined = () => undefined
export function setWorktreeMover(mover: WorktreeMover, sessionActor: (sessionId: string) => Actor | undefined): void {
  worktreeMover = mover
  actorOfSession = sessionActor
}

const MOVE_CHECKOUT_DESC = [
  'Say where THIS session works next: a checkout of its repository, and the branch that checkout must be on. Solus works out the Git steps and binds the session there, so the diff, Git status, changed files, and branch follow. Use this, not `git worktree add`, `git switch` in another checkout, `cd`, or EnterWorktree, to start isolated work in a worktree or to leave one. Get the paths and branches from `checkout_status` first.',
  'Call last in your turn. Your process stays in the old folder until the turn ends; the next turn starts in the new one with the conversation kept. `continue_with` starts that turn; without it, the session waits for the next message.',
  'Git steps that change a checkout run when the turn ends, and the result lists them. A checkout they change must have no uncommitted changes, and no other session can work in it. A branch checked out in the worktree you leave is freed only with `remove_worktree`.',
].join('\n\n')

const moveCheckoutFields = {
  checkout: z.string().min(1).describe('The checkout to work in: its path as checkout_status lists it (the project folder or a worktree), or "new_worktree" to make a new worktree.'),
  branch: z.string().min(1).optional().describe('The branch that checkout must be on: an existing branch, or a new one to make. Omitted: the checkout keeps its branch, and a new worktree gets a branch the naming settings name.'),
  base_branch: z.string().min(1).optional().describe('Only for a branch that does not exist yet: the branch it starts from. Default: the target branch.'),
  remove_worktree: z.boolean().optional().describe('Remove the worktree you leave when the turn ends. Its branch and commits stay. Default false.'),
  continue_with: z.string().max(120_000).optional().describe('Work to resume in the new checkout next turn. Omitted: the session waits.'),
}

// Strict: a field the tool does not know, such as a misspelled option, is refused, not dropped.
const moveCheckoutInput = z.object(moveCheckoutFields).strict()

export const moveCheckoutAgentTool: AgentTool = {
  name: 'move_checkout',
  description: MOVE_CHECKOUT_DESC,
  inputFields: moveCheckoutFields,
  requiresApproval: false,
  execute: async (rawInput, context) => {
    const parsed = moveCheckoutInput.safeParse(rawInput)
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
    const input = parsed.data
    const sessionId = context.sessionId()
    if (!sessionId) return { ok: false, text: 'move_checkout needs a Solus session. A sub-agent cannot move its parent session.' }
    if (!worktreeMover) return { ok: false, text: 'Checkout moves are not available on this host.' }
    const result = await worktreeMover.moveForAgent({
      sessionId,
      cwd: resolveHomePath(context.cwd),
      checkout: input.checkout === 'new_worktree' ? 'new_worktree' : resolveHomePath(input.checkout),
      branch: input.branch,
      baseBranch: input.base_branch,
      removeWorktree: input.remove_worktree,
      continueWith: input.continue_with,
      actor: actorOfSession(sessionId) ?? HOST_ACTOR,
      preferences: sessionSettings(sessionId)?.preferences,
      signal: context.abortSignal,
    })
    if (!result.success || !result.directory) return { ok: false, text: result.error ?? 'The move failed.' }
    return { ok: true, text: moveResultText(result, !!input.continue_with) }
  },
}

function moveResultText(result: AgentMoveResult, continues: boolean): string {
  const place = `${result.directory} on ${result.branch ?? 'a detached HEAD'}`
  const steps = result.steps.length === 1 ? result.steps[0] : result.steps.map((step, index) => `(${index + 1}) ${step}`).join(', ')
  const first = result.movesAtTurnEnd
    ? `Move recorded. When this turn ends, Solus will ${steps}. Then the session works in ${place}. If a step fails, the steps after it do not run.`
    : `Moved this session to ${place}.${result.steps.length > 0 ? ` When this turn ends, Solus will ${steps}. If it cannot, the worktree stays.` : ''}`
  const next = continues
    ? 'Your continue_with prompt then starts the next turn there, with the conversation kept.'
    : 'The conversation continues there when the session gets its next message. Pass continue_with to resume automatically.'
  return `${first} End your turn now: your process stays in the old folder until it ends. ${next}`
}

const CHECKOUT_STATUS_DESC = [
  'Report where Solus binds THIS session and every checkout of its repository: the project folder first, then each worktree, with its branch, uncommitted changes, and the other sessions that work there. Check before `move_checkout`.',
  'Pass `branches` to also list branches, each with the checkout that holds it. The list does not fetch unless `refresh` is true.',
].join('\n\n')

const checkoutStatusFields = {
  branches: z.object({
    query: z.string().max(256).optional().describe('Only branches whose name contains this text.'),
    kind: z.enum(['local', 'remote', 'all']).optional().describe('Default "local".'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
    cursor: z.number().int().min(0).optional().describe('The `next cursor` of the previous page.'),
    refresh: z.boolean().optional().describe('Run `git fetch --all --prune` first. Default false.'),
  }).optional().describe('List branches too. Omit for the checkouts only.'),
}

const checkoutStatusInput = z.object(checkoutStatusFields)

export const checkoutStatusAgentTool: AgentTool = {
  name: 'checkout_status',
  description: CHECKOUT_STATUS_DESC,
  inputFields: checkoutStatusFields,
  requiresApproval: false,
  execute: async (rawInput, context) => {
    const parsed = checkoutStatusInput.safeParse(rawInput)
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) }
    const sessionId = context.sessionId()
    if (!sessionId) return { ok: false, text: 'checkout_status needs a Solus session.' }
    if (!worktreeMover) return { ok: false, text: 'Checkout status is not available on this host.' }
    const status = await worktreeMover.status(sessionId, resolveHomePath(context.cwd))
    if (!status) return { ok: true, text: 'This session is not in a git repository.' }
    const lines = [checkoutStatusText(status)]
    const branches = parsed.data.branches
    if (branches) lines.push('', await branchListText(status.directory, branches))
    return { ok: true, text: lines.join('\n') }
  },
}

export function checkoutStatusText(status: WorktreeStatus): string {
  const isWorktree = status.checkouts.findIndex((checkout) => checkout.holdsSession) > 0
  const lines = [`Bound directory: ${status.directory} (${isWorktree ? 'a linked worktree' : 'the project folder'})`]
  if (status.checkout) {
    lines.push(`Branch: ${status.checkout.branch ?? `detached at ${status.checkout.detachedHeadSha ?? 'an unknown commit'}`}`)
    lines.push(`Target branch: ${status.checkout.targetBranch}`)
  }
  lines.push('', 'Checkouts of this repository:')
  status.checkouts.forEach((checkout, index) => {
    const notes = [
      index === 0 && 'project folder',
      checkout.holdsSession && 'this session',
      checkout.changes > 0 && `${checkout.changes} uncommitted ${checkout.changes === 1 ? 'change' : 'changes'}`,
      checkout.sessions.length > 0 && `${checkout.sessions.length} other ${checkout.sessions.length === 1 ? 'session' : 'sessions'}`,
    ].filter(Boolean)
    lines.push(`- ${checkout.path} on ${checkout.branch ?? 'a detached HEAD'}${notes.length ? ` (${notes.join(', ')})` : ''}`)
  })
  return lines.join('\n')
}

type BranchQuery = NonNullable<z.infer<typeof checkoutStatusInput>['branches']>

async function branchListText(directory: string, query: BranchQuery): Promise<string> {
  const lines: string[] = []
  if (query.refresh) {
    await runAsync('git', ['fetch', '--all', '--prune'], directory).catch((error: Error) => {
      lines.push(`The fetch failed, so remote branches may be old: ${error.message}`)
    })
  }
  const kind = query.kind ?? 'local'
  const text = query.query?.toLowerCase()
  const matching = (await listBranchRefs(directory, { remoteOnly: kind === 'remote' }))
    .filter((branch) => kind !== 'local' || !branch.remoteOnly)
    .filter((branch) => !text || branch.name.toLowerCase().includes(text))
  if (matching.length === 0) return [...lines, `No ${kind === 'all' ? '' : `${kind} `}branches match.`].join('\n')
  const start = query.cursor ?? 0
  const page = matching.slice(start, start + (query.limit ?? 50))
  lines.push(`Branches (${kind}), ${start + 1}–${start + page.length} of ${matching.length}, most recently active first:`)
  for (const branch of page) lines.push(`- ${branchLine(branch, directory)}`)
  if (start + page.length < matching.length) lines.push(`next cursor: ${start + page.length}`)
  return lines.join('\n')
}

function branchLine(branch: BranchRef, directory: string): string {
  const notes = [
    branch.remoteOnly ? 'remote only' : 'local',
    branch.isDefault && 'default',
    branch.current && `checked out in ${directory}`,
    branch.worktreePath && `checked out in ${branch.worktreePath}`,
  ].filter(Boolean)
  return `${branch.name} (${notes.join(', ')})`
}
