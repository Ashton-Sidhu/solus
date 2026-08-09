import { writeFile } from 'fs/promises'
import type { ControlPlane } from '../../control-plane'
import { gitCheckoutFromState, type IpcContext, type DiffFileContentsRequest, type DiffRequest, type GitCheckoutBranchResult, type GitStateOptions } from '../../../shared/types'
import { createPR, commitAndPushChanges, commitChanges, discardChanges, syncWithOrigin, listBranches, listProjectWorktrees, getWorkingBranch, getDefaultBranch, restoreWorktree, createWorktree, buildBranchNamePrompt, buildCommitMessagePrompt, COMMIT_MESSAGE_SYSTEM_PROMPT } from '../../git/worktree-manager'
import { runAsync } from '../../git/exec'
import { computeGitIdentity, computeGitState, resolveRepoRoot } from '../../git/git-helpers'
import { getDiff, getDiffFileContents, getDiffStats, listTurnSnapshots } from '../../git/session-snapshots'
import { TextGenerator } from '../../agents/text-generator'
import { createLogger } from '../../logger'
import { Task } from '../../tasks/task'
import type { SolusServer } from '../server'

const log = createLogger('main', 'worktree-handlers')

export interface WorktreeDeps {
  controlPlane: ControlPlane
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

async function repoRootForCtx(ctx: IpcContext): Promise<string | null> {
  const gitContext = await resolveGitCheckout(ctx)
  const workTree = gitContext?.worktreePath || ctx.session.workingDirectory
  if (!workTree || workTree === '~') return null
  return resolveRepoRoot(workTree)
}

export function registerWorktreeHandlers(server: SolusServer, deps: WorktreeDeps): void {
  const { controlPlane } = deps
  const textGenerator = new TextGenerator(controlPlane)

  /** Every path that writes a commit — commit, commit & push, open a PR —
   *  generates its subject the same way, off the session's own provider/model. */
  const commitMessageOptions = (ctx: IpcContext) => ({
    generateCommitMessage: async (cwd: string) => textGenerator.generate({
      provider: ctx.session.provider ?? ctx.settings.activeAgent,
      model: ctx.statusBar.model,
      cwd,
      prompt: await buildCommitMessagePrompt(cwd),
      systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
      disableReasoning: true,
      maxTurns: 1,
      timeoutMs: 30_000,
    }),
  })

  server.register('worktreeListProject', (args) => {
    const [ctx] = args as [IpcContext]
    const dir = ctx.session.workingDirectory
    if (!dir || dir === '~') return []
    return listProjectWorktrees(dir)
  })

  server.register('diff', async (args) => {
    const [ctx, request] = args as [IpcContext, DiffRequest]
    log.info('rpc_diff', { sessionId: ctx.session.sessionId, scopeKind: request.scope.kind })
    const repoRoot = await repoRootForCtx(ctx)
    if (!repoRoot) return null
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return await getDiff(workTree, repoRoot, request.scope, sid, livePaths)
  })

  server.register('diffFileContents', async (args) => {
    const [ctx, request] = args as [IpcContext, DiffFileContentsRequest]
    const repoRoot = await repoRootForCtx(ctx)
    if (!repoRoot) return null
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    return getDiffFileContents(workTree, repoRoot, sid, request)
  })

  server.register('diffStats', async (args) => {
    const [ctx, request] = args as [IpcContext, DiffRequest]
    const repoRoot = await repoRootForCtx(ctx)
    if (!repoRoot) return []
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return getDiffStats(workTree, repoRoot, request.scope, sid, livePaths)
  })

  server.register('listTurnSnapshots', async (args) => {
    const [ctx] = args as [IpcContext]
    const sid = ctx.session.agentSessionId
    if (!sid) return []
    const repoRoot = await repoRootForCtx(ctx)
    if (!repoRoot) return []
    return await listTurnSnapshots(repoRoot, sid)
  })

  server.register('worktreePR', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info('rpc_worktree_pr', { sessionId: ctx.session.sessionId })
    if (!ctx.session.gitContext) return { success: false, error: 'No active git branch for this tab' }
    const cwd = ctx.session.gitContext.worktreePath || ctx.session.workingDirectory
    const result = await createPR(ctx.session.gitContext, ctx.session.workingDirectory, {
      ...commitMessageOptions(ctx),
      generatePRText: (prompt) => textGenerator.generate({
        provider: ctx.session.provider ?? ctx.settings.activeAgent,
        model: ctx.statusBar.model,
        cwd,
        prompt,
        disableReasoning: true,
        maxTurns: 1,
        timeoutMs: 30_000,
      }),
    })
    const sessionId = ctx.session.agentSessionId
    const match = result.success ? result.url?.match(/\/pull\/(\d+)(?:[/?#]|$)/) : null
    if (sessionId && result.url && match) {
      const task = await Task.forSession(sessionId)
      await task?.linkPullRequest({
        number: Number(match[1]),
        url: result.url,
        targetScope: ctx.session.projectPath || ctx.session.workingDirectory,
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

  server.register('gitCommit', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info('rpc_git_commit', { sessionId: ctx.session.sessionId })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) return { success: false, outcome: 'failed', committed: false, error: 'No active git branch for this tab' }
    return commitChanges(gitContext, ctx.session.workingDirectory, commitMessageOptions(ctx))
  })

  server.register('gitCommitPush', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info('rpc_git_commit_push', { sessionId: ctx.session.sessionId })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) return { success: false, outcome: 'failed', committed: false, pushed: false, error: 'No active git branch for this tab' }
    return commitAndPushChanges(gitContext, ctx.session.workingDirectory, commitMessageOptions(ctx))
  })

  server.register('gitDiscard', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info('rpc_git_discard', { sessionId: ctx.session.sessionId })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) return { success: false, discarded: 0, error: 'No active git branch for this tab' }
    return discardChanges(gitContext, ctx.session.workingDirectory)
  })

  server.register('gitSync', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info('rpc_git_sync', { sessionId: ctx.session.sessionId })
    const gitContext = await resolveGitCheckout(ctx)
    if (!gitContext) return { success: false, outcome: 'failed', error: 'No active git branch for this tab' }
    return syncWithOrigin(gitContext, ctx.session.workingDirectory)
  })

  server.register('gitCheckoutBranch', async (args): Promise<GitCheckoutBranchResult> => {
    const [ctx, branch] = args as [IpcContext, string]
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
    } catch (err: any) {
      return { success: false, error: err?.message ?? 'Checkout failed' }
    }
  })

  server.register('worktreeBranches', async (args) => {
    const [ctx] = args as [IpcContext]
    const cwd = ctx.session.workingDirectory
    if (!cwd || cwd === '~') return []
    await runAsync('git', ['fetch', '--all', '--prune'], cwd).catch((err) => {
      log.warn('branch_fetch_before_list_failed', { error: err instanceof Error ? err.message : String(err) })
    })
    return listBranches(cwd)
  })

  server.register('worktreeRestore', (args) => {
    const [ctx, worktreePath, options] = args as [IpcContext, string, { includePr?: boolean } | undefined]
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
    const [ctx, namePrompt] = args as [IpcContext, string | undefined]
    log.info('rpc_continue_in_worktree', { sessionId: ctx.session.sessionId })
    const cwd = ctx.session.workingDirectory
    if (!cwd || cwd === '~') return { success: false, error: 'No active git repository for this tab' }
    if (ctx.session.gitContext?.worktreePath) return { success: false, error: 'Session is already in a worktree' }
    const repoRoot = await resolveRepoRoot(cwd)
    if (!repoRoot) return { success: false, error: 'Not a git repository' }
    try {
      const branchModel = ctx.session.provider === 'codex' ? 'gpt-5.4-mini' : 'claude-haiku-4-5-20251001'
      const gitContext = await createWorktree(repoRoot, namePrompt || '', ctx.session.gitContext?.targetBranch, {
        generateName: (prompt) => textGenerator.generate({
          provider: ctx.session.provider ?? ctx.settings.activeAgent,
          cwd: repoRoot,
          prompt: buildBranchNamePrompt(prompt),
          model: branchModel,
          reasoningEffort: 'none',
          maxTurns: 1,
          timeoutMs: 30_000,
        }),
      })
      controlPlane.setSessionGitEnvironment(ctx.session.sessionId, gitContext.worktreePath ?? cwd, gitContext)
      return { success: true, gitContext }
    } catch (err: any) {
      log.error('continue_in_worktree_failed', { error: err instanceof Error ? err.message : String(err) })
      return { success: false, error: err?.message ?? 'Failed to create worktree' }
    }
  })

  server.register('gitRefreshState', async (args) => {
    const [cwd, options] = args as [string, GitStateOptions | undefined]
    return computeGitState(cwd, options)
  })

  server.register('gitIdentity', async (args) => computeGitIdentity((args as [string])[0]))

  server.register('gitRegisterEnvironment', (args) => {
    const [ctx, cwd, gitContext] = args as [IpcContext, string, ReturnType<typeof gitCheckoutFromState>]
    controlPlane.setSessionGitEnvironment(ctx.session.sessionId, cwd, gitContext)
  })

  server.register('writePlanFile', async (args) => {
    const [filePath, content] = args as [string, string]
    try {
      await writeFile(filePath, content, 'utf-8')
      log.info('rpc_write_plan_file', { filePath, contentLength: content.length })
      return { ok: true }
    } catch (err: any) {
      log.error('rpc_write_plan_file_failed', { filePath, error: err instanceof Error ? err.message : String(err) })
      return { ok: false, error: err?.message ?? String(err) }
    }
  })
}
