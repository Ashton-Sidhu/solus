import { writeFile } from 'fs/promises'
import type { ControlPlane } from '../../control-plane'
import { gitCheckoutFromState, projectScopeOf, type IpcContext, type GitCheckoutBranchResult, type PrRepoCheckoutResult } from '../../../shared/types'
import { discardChanges, syncWithOrigin, listBranches, listProjectWorktrees, getWorkingBranch, getDefaultBranch, restoreWorktree, createWorktree, buildCommitMessagePrompt, COMMIT_MESSAGE_SYSTEM_PROMPT, checkoutPrInRepo, type PrRepoCheckoutBlockReason } from '../../git/worktree-manager'
import { runGitAction } from '../../git/git-action-manager'
import { runAsync } from '../../git/exec'
import { computeGitIdentity, computeGitState, resolveRepoRoot } from '../../git/git-helpers'
import { getDiff, getDiffFileContents, getDiffStats, listTurnSnapshots } from '../../git/session-snapshots'
import { TextGenerator } from '../../agents/text-generator'
import { createLogger } from '../../logger'
import { Task } from '../../tasks/task'
import { githubTokenForCheckout } from '../../providers/github/credentials'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { resolveSourceControlWritingPolicy } from '../../git/source-control-writing'
import { getServerSettings, resolveSourceControlWriterModel } from '../settings'
import { reviewTargetFor } from './provider-handlers'

const log = createLogger('main', 'worktree-handlers')

export interface WorktreeDeps {
  controlPlane: ControlPlane
  events: HostEventPublisher
}

async function resolveGitCheckout(ctx: IpcContext) {
  let gitContext = ctx.session.gitContext ?? undefined
  if (!gitContext && ctx.session.workingDirectory && ctx.session.workingDirectory !== '~') {
    const branch = getWorkingBranch(ctx.session.workingDirectory)
    const targetBranch = await getDefaultBranch(ctx.session.workingDirectory)
    if (branch) {
      gitContext = { branch, targetBranch }
    }
  }
  return gitContext
}

async function workTreeForCtx(ctx: IpcContext): Promise<string | null> {
  const gitContext = await resolveGitCheckout(ctx)
  return gitContext?.worktreePath || ctx.session.workingDirectory || null
}

/** The repo root behind the session's *active checkout* — its worktree when it
 *  has one. Deliberately not `repoRootOrNull`, which starts from the project
 *  scope: a session working in a worktree must diff that worktree, not the
 *  project it branched from. */
async function checkoutRepoRoot(ctx: IpcContext): Promise<string | null> {
  const gitContext = await resolveGitCheckout(ctx)
  const workTree = gitContext?.worktreePath || ctx.session.workingDirectory
  if (!workTree || workTree === '~') return null
  return resolveRepoRoot(workTree)
}

function prRepoCheckoutBlockedMessage(reason: PrRepoCheckoutBlockReason, worktreePath?: string): string {
  switch (reason) {
    case 'stale-head':
      return 'This pull request changed. Refresh it and try again.'
    case 'dirty':
      return 'Commit or discard local changes before checking out this pull request here.'
    case 'conflicted':
      return 'Resolve merge conflicts before checking out this pull request here.'
    case 'branch-in-use':
      return worktreePath
        ? `This branch is already checked out at ${worktreePath}.`
        : 'This branch is already checked out in another worktree.'
  }
}

export function registerWorktreeHandlers(server: SolusServer, deps: WorktreeDeps): void {
  const { controlPlane } = deps
  const textGenerator = new TextGenerator(controlPlane)

  const generateCommitSubject = async (
    cwd: string,
    writer: ReturnType<typeof resolveSourceControlWriterModel>,
    instructions: string,
  ) => textGenerator.generate({
    provider: writer.provider,
    model: writer.model,
    cwd,
    prompt: [
      await buildCommitMessagePrompt(cwd),
      '',
      'Writing policy:',
      instructions,
    ].join('\n'),
    systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
    disableReasoning: true,
    maxTurns: 1,
    timeoutMs: 30_000,
  })

  server.register('worktreeListProject', (args) => {
    const [ctx] = args
    const dir = ctx.session.workingDirectory
    if (!dir || dir === '~') return []
    return listProjectWorktrees(dir)
  })

  server.register('diff', async (args) => {
    const [ctx, request] = args
    log.info('rpc_diff', { sessionId: ctx.session.sessionId, scopeKind: request.scope.kind })
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return null
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return await getDiff(workTree, repoRoot, request.scope, sid, livePaths)
  })

  server.register('diffFileContents', async (args) => {
    const [ctx, request] = args
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return null
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    return getDiffFileContents(workTree, repoRoot, sid, request)
  })

  server.register('diffStats', async (args) => {
    const [ctx, request] = args
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return []
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return getDiffStats(workTree, repoRoot, request.scope, sid, livePaths)
  })

  server.register('listTurnSnapshots', async (args) => {
    const [ctx] = args
    const sid = ctx.session.agentSessionId
    if (!sid) return []
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return []
    return await listTurnSnapshots(repoRoot, sid)
  })

  server.register('gitRunAction', async (args, handlerCtx) => {
    const [ctx, request] = args
    log.info('rpc_git_run_action', { sessionId: ctx.session.sessionId, action: request.action })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) throw new Error('No active git branch for this session.')
    const cwd = gitContext.worktreePath || ctx.session.workingDirectory
    const policy = await resolveSourceControlWritingPolicy(
      cwd,
      getServerSettings().sourceControlWriting,
    )
    const writerModel = resolveSourceControlWriterModel()
    const result = await runGitAction(request, gitContext, ctx.session.workingDirectory, {
      writer: {
        provider: writerModel.provider,
        model: writerModel.model,
        textGenerator,
        instructions: policy.pullRequestInstructions,
        followPullRequestTemplate: policy.followPullRequestTemplate,
      },
      generateCommitSubject: (targetCwd) => generateCommitSubject(
        targetCwd,
        writerModel,
        policy.commitInstructions,
      ),
      // `gh` must act as whoever the checkout's credential helper pushes as, so
      // a dispatched branch is not opened as a PR by the host owner.
      githubToken: githubTokenForCheckout(cwd),
      publish: (event) => {
        if (handlerCtx.clientId) deps.events.publish(handlerCtx.clientId, 'git.actionProgressed', event)
        else deps.events.broadcast('git.actionProgressed', event)
      },
    })
    if (result.branch.status === 'created') {
      const nextGitContext = { ...gitContext, branch: result.branch.name }
      controlPlane.setSessionGitEnvironment(
        ctx.session.sessionId,
        nextGitContext.worktreePath ?? ctx.session.workingDirectory,
        nextGitContext,
      )
    }
    const pullRequest = result.pullRequest
    const sessionId = ctx.session.agentSessionId
    if (sessionId && pullRequest.status !== 'skipped' && pullRequest.number !== null) {
      const task = await Task.forSession(sessionId)
      await task?.linkPullRequest({
        number: pullRequest.number,
        url: pullRequest.url,
        targetScope: projectScopeOf(ctx.session),
        originSessionId: sessionId,
        createdBy: 'agent',
      }).catch((error) => {
        log.warn('task_pr_link_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    return result
  })

  server.register('gitDiscard', async (args) => {
    const [ctx] = args
    log.info('rpc_git_discard', { sessionId: ctx.session.sessionId })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) return { success: false, discarded: 0, error: 'No active git branch for this tab' }
    return discardChanges(gitContext, ctx.session.workingDirectory)
  })

  server.register('gitSync', async (args) => {
    const [ctx] = args
    log.info('rpc_git_sync', { sessionId: ctx.session.sessionId })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) return { success: false, outcome: 'failed', error: 'No active git branch for this tab' }
    return syncWithOrigin(gitContext, ctx.session.workingDirectory)
  })

  server.register('gitCheckoutBranch', async (args): Promise<GitCheckoutBranchResult> => {
    const [ctx, branch] = args
    log.info('rpc_git_checkout_branch', { sessionId: ctx.session.sessionId, branch })
    try {
      const cwd = ctx.session.workingDirectory
      if (!cwd || cwd === '~') return { success: false, error: 'No active git repository for this tab' }
      if (!branch || !listBranches(cwd).includes(branch)) {
        return { success: false, error: `Branch not found: ${branch}` }
      }
      await runAsync('git', ['checkout', branch], cwd)
      const gitContext = gitCheckoutFromState(await computeGitState(cwd))
      if (!gitContext) return { success: false, error: 'Checkout succeeded but branch status could not be resolved' }
      controlPlane.setSessionGitEnvironment(ctx.session.sessionId, cwd, gitContext)
      return { success: true, gitContext }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Checkout failed' }
    }
  })

  server.register('prCheckoutInRepo', async (args): Promise<PrRepoCheckoutResult> => {
    const [ctx, target] = args
    log.info('rpc_pr_checkout_in_repo', { sessionId: ctx.session.sessionId, prNumber: target.number })
    try {
      const { repo, provider } = await reviewTargetFor(ctx)
      if (repo.host !== target.host || repo.owner !== target.owner || repo.repo !== target.repo) {
        return { success: false, reason: 'generic', error: 'The pull request does not belong to this project.' }
      }
      const detail = await provider.review.getPullRequest(repo, target.number)
      if (detail.headSha !== target.headSha) {
        return { success: false, reason: 'stale-head', error: 'This pull request changed. Refresh it and try again.' }
      }
      const cwd = ctx.session.workingDirectory
      if (!cwd || cwd === '~') return { success: false, reason: 'generic', error: 'No active git repository for this tab' }
      const repoRoot = await resolveRepoRoot(cwd)
      if (!repoRoot) return { success: false, reason: 'generic', error: 'Not a git repository' }

      const outcome = await checkoutPrInRepo(repoRoot, target.number, target.headSha, {
        headRef: detail.headRef,
        isFork: detail.headRepo.isFork,
      })
      if (outcome.outcome === 'blocked') {
        return {
          success: false,
          reason: outcome.reason,
          worktreePath: outcome.worktreePath,
          error: prRepoCheckoutBlockedMessage(outcome.reason, outcome.worktreePath),
        }
      }

      const gitContext = gitCheckoutFromState(await computeGitState(repoRoot))
      if (!gitContext) return { success: false, reason: 'generic', error: 'Checkout succeeded but branch status could not be resolved' }
      controlPlane.setSessionGitEnvironment(ctx.session.sessionId, repoRoot, gitContext)
      return { success: true, gitContext }
    } catch (err) {
      return { success: false, reason: 'generic', error: err instanceof Error ? err.message : 'Checkout failed' }
    }
  })

  server.register('worktreeBranches', async (args) => {
    const [ctx, options] = args
    const cwd = ctx.session.workingDirectory
    if (!cwd || cwd === '~') return []
    await runAsync('git', ['fetch', '--all', '--prune'], cwd).catch((err) => {
      log.warn('branch_fetch_before_list_failed', { error: err instanceof Error ? err.message : String(err) })
    })
    return listBranches(cwd, options)
  })

  server.register('worktreeRestore', (args) => {
    const [ctx, worktreePath, options] = args
    log.info('rpc_worktree_restore', { sessionId: ctx.session.sessionId })
    if (ctx.session.gitContext?.worktreePath && ctx.session.gitContext.worktreePath === worktreePath) {
      controlPlane.setSessionGitEnvironment(ctx.session.sessionId, worktreePath, ctx.session.gitContext)
      return ctx.session.gitContext
    }
    const gitContext = restoreWorktree(worktreePath, options)
    if (gitContext) controlPlane.setSessionGitEnvironment(ctx.session.sessionId, worktreePath, gitContext)
    return gitContext
  })

  // Create a fresh worktree for a live session so it can "continue" there. The
  // renderer then flags the session to fork on its next prompt, re-homing the
  // conversation under the worktree. Eager creation (vs. the lazy worktree path)
  // gives us the branch name up front for the UI + git panel.
  server.register('continueInWorktree', async (args) => {
    const [ctx, namePrompt] = args
    log.info('rpc_continue_in_worktree', { sessionId: ctx.session.sessionId })
    const cwd = ctx.session.workingDirectory
    if (!cwd || cwd === '~') return { success: false, error: 'No active git repository for this tab' }
    if (ctx.session.gitContext?.worktreePath) return { success: false, error: 'Session is already in a worktree' }
    const repoRoot = await resolveRepoRoot(cwd)
    if (!repoRoot) return { success: false, error: 'Not a git repository' }
    try {
      const gitContext = await createWorktree(repoRoot, namePrompt || '', ctx.session.gitContext?.targetBranch)
      controlPlane.setSessionGitEnvironment(ctx.session.sessionId, gitContext.worktreePath ?? cwd, gitContext)
      return { success: true, gitContext }
    } catch (err) {
      log.error('continue_in_worktree_failed', { error: err instanceof Error ? err.message : String(err) })
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create worktree' }
    }
  })

  server.register('gitRefreshState', async (args) => {
    const [cwd, options] = args
    return computeGitState(cwd, options)
  })

  server.register('gitIdentity', async ([cwd]) => computeGitIdentity(cwd))

  server.register('gitRegisterEnvironment', (args) => {
    const [ctx, cwd, gitContext] = args
    controlPlane.setSessionGitEnvironment(ctx.session.sessionId, cwd, gitContext)
  })

  server.register('writePlanFile', async (args) => {
    const [filePath, content] = args
    try {
      await writeFile(filePath, content, 'utf-8')
      log.info('rpc_write_plan_file', { filePath, contentLength: content.length })
      return { ok: true }
    } catch (err) {
      log.error('rpc_write_plan_file_failed', { filePath, error: err instanceof Error ? err.message : String(err) })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
