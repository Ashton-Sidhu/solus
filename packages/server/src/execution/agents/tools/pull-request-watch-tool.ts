import { z } from 'zod'
import { resolveRepoRoot } from '../../../git/git-helpers'
import { resolveHomePath } from '../../../platform/paths'
import { stopPullRequestWatch } from '../../../data/sessions/pull-request-watches'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { startSessionPullRequestWatch, type WatchStartOutcome } from '../../../prs/start-pull-request-watch'
import type { AgentTool } from './agent-tool'
import { linkCallerPullRequest, namedPullRequest, type TaskToolCtx, type TaskToolResult } from './task-tools'

/**
 * `watch_pull_request` (docs/plans/pr-watch.md §1): one tool starts and stops
 * a watch. It links the pull request to the calling session first, so the
 * person sees what is watched in the session's Linked card.
 */

const DESCRIPTION =
  "Watch a pull request linked to this session: Solus reads it in the background and wakes you with a message when a check fails, every required check passes, someone comments or reviews, the branch starts to conflict, or the pull request is closed. After you call it, end your turn; do not poll with gh, sleep, or a watch loop. Pass watching=false to stop, and stop the watch before you hand the work back. A watch ends by itself when the pull request merges or closes, or when the session is stopped or settled."

const fields = {
  pull_request: z.string().describe('The pull request number, or its GitHub URL.'),
  watching: z.boolean().optional().describe('false stops the watch. Defaults to true.'),
}
const inputSchema = z.object(fields)

async function watchPullRequest(input: z.output<typeof inputSchema>, ctx: TaskToolCtx): Promise<TaskToolResult> {
  const sessionId = ctx.sessionId
  if (!sessionId) return { ok: false, text: 'watch_pull_request needs a calling session, and this session has no id yet.' }
  const projectKey = await resolveRepoRoot(ctx.cwd) ?? ctx.cwd
  const identity = await namedPullRequest(projectKey, input.pull_request)
  if (!identity) return { ok: false, text: `watch_pull_request could not find pull request "${input.pull_request}". Pass its number or URL.` }
  const label = `pull request #${identity.number} (${identity.repository})`

  if (input.watching === false) {
    return await stopPullRequestWatch(sessionId, identity.repository, identity.number)
      ? { ok: true, text: `Stopped watching ${label}.` }
      : { ok: true, text: `This session was not watching ${label}.` }
  }

  // Settled or already watched: answered before the link, which would
  // otherwise make a settled session's link for nothing.
  let outcome = await startSessionPullRequestWatch(sessionId, identity.repository, identity.number)
  if (outcome === 'not-linked') {
    const linked = await linkCallerPullRequest(ctx, () => workspaceToolContext(sessionId), projectKey, { target_id: identity.url })
    if (!linked.ok) return linked
    outcome = await startSessionPullRequestWatch(sessionId, identity.repository, identity.number)
  }
  return outcomeResult(outcome, label)
}

function outcomeResult(outcome: WatchStartOutcome, label: string): TaskToolResult {
  switch (outcome) {
    case 'started': return { ok: true, text: `Watching ${label}. End your turn now; Solus wakes you when something changes.` }
    case 'already-watching': return { ok: true, text: `Already watching ${label}. End your turn; Solus wakes you when something changes.` }
    case 'session-settled': return { ok: false, text: 'This session is settled, so nothing would act on what a watch finds. Make the session active first.' }
    case 'not-linked': return { ok: false, text: `${label} could not be linked to this session, so it cannot be watched.` }
    default: return { ok: false, text: `${label} is ${outcome}, so there is nothing to watch.` }
  }
}

export const watchPullRequestAgentTool: AgentTool<typeof fields> = {
  name: 'watch_pull_request',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  execute: async (args, context) => watchPullRequest(inputSchema.parse(args), {
    cwd: resolveHomePath(context.cwd), sessionId: context.sessionId(), agentProvider: context.provider,
  }),
}
