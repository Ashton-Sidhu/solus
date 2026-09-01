import { writeFile } from 'fs/promises'
import type { ControlPlane } from '../../control-plane'
import { gitCheckoutFromState, projectScopeOf, type IpcContext, type GitCheckoutBranchResult } from '@solus/contracts/types'
import { discardChanges, syncWithOrigin, listBranches, listProjectWorktrees, getWorkingBranch, getDefaultBranch, restoreWorktree, createWorktree, buildCommitMessagePrompt, COMMIT_MESSAGE_SYSTEM_PROMPT } from '../../git/worktree-manager'
import { runGitAction } from '../../git/git-action-manager'
import { runAsync } from '../../git/exec'
import { computeGitIdentity, computeGitState, resolveRepoRef, resolveRepoRoot } from '../../git/git-helpers'
import { getDiff, getDiffFileContents, getDiffStats, listTurnSnapshots } from '../../git/session-snapshots'
import { TextGenerator } from '../../agents/text-generator'
import { createLogger } from '../../logger'
import { Task } from '../../tasks/task'
import { githubTokenForCheckout, hostGithubToken } from '../../providers/github/credentials'
import { GitHubAuth } from '../../providers/github/auth'
import { buildClient, buildDelegatedClient } from '../../providers/github/octokit'
import { providerForRepo } from '../../providers/registry'
import { prIndex } from '../../prs/pr-index'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { resolveSourceControlWritingPolicy } from '../../git/source-control-writing'
import { generateWorktreeName } from '../../git/worktree-name'
import { getHostConfig, getServerSettings, resolveSourceControlWriterModel } from '../settings'

const log = createLogger('main', 'worktree-handlers')

/**
 * `continueInWorktree` setups in flight, per session. The RPC awaits a model
 * call with a 30s ceiling, so without a signal a user who asks twice waits out
 * the first run before the second starts. A superseding request aborts the
 * whole setup it replaces — naming *and* worktree creation, since a worktree
 * for a superseded request is one the user never asked for.
 *
 * Known gap: this is a second registry beside `ControlPlane.pendingSetupControllers`,
 * which is what `stopSession` aborts. Stopping a session therefore does not
 * cancel a setup started here. Closing that means moving worktree provisioning
 * onto the ControlPlane, which owns session lifecycle — deliberately out of
 * scope for a review fix.
 */
const pendingWorktreeSetups = new Map<string, AbortController>()

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
      getHostConfig().config.sourceControlWriting,
    )
    const writerModel = resolveSourceControlWriterModel()
    const pullRequestRequested = request.action === 'create_pull_request'
      || request.action === 'commit_push_pull_request'
    const githubToken = pullRequestRequested ? githubTokenForCheckout(cwd) : null
    const hostToken = hostGithubToken()
    const githubClient = githubToken
      ? githubToken === hostToken
        ? await buildClient(new GitHubAuth())
        : buildDelegatedClient(githubToken)
      : null
    const githubRepo = githubClient ? await resolveRepoRef(cwd) : null
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
      // CLI fallbacks always use the GitHub CLI's normal credential store, just
      // like a manual `gh pr create`. Do not inject the API credential into it.
      githubClient,
      githubRepo,
      // Creating a pull request also creates the entity for it, and forgets the
      // listings it now belongs on. The read that follows is the one the client
      // would otherwise have made itself a round trip later.
      readPullRequest: async (number) => {
        const repo = githubRepo ?? await resolveRepoRef(cwd)
        const provider = repo ? providerForRepo(repo) : null
        if (!repo || !provider) return null
        prIndex.invalidate(repo)
        return prIndex.pullRequest(repo, provider, number).read()
      },
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
    const [ctx, worktreePath] = args
    log.info('rpc_worktree_restore', { sessionId: ctx.session.sessionId })
    if (ctx.session.gitContext?.worktreePath && ctx.session.gitContext.worktreePath === worktreePath) {
      controlPlane.setSessionGitEnvironment(ctx.session.sessionId, worktreePath, ctx.session.gitContext)
      return ctx.session.gitContext
    }
    const gitContext = restoreWorktree(worktreePath)
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
    const sessionId = ctx.session.sessionId
    const setup = new AbortController()
    pendingWorktreeSetups.get(sessionId)?.abort(new Error('Superseded'))
    pendingWorktreeSetups.set(sessionId, setup)
    try {
      const prompt = namePrompt || ''
      // The generated name is an enrichment: `createWorktree` derives one from
      // the prompt when this is null. Abort it rather than let it hold the
      // worktree, and keep going on the fallback name.
      const generatedName = await generateWorktreeName(controlPlane, prompt, repoRoot, setup.signal)
        .catch(() => null)
      const gitContext = await createWorktree(repoRoot, prompt, ctx.session.gitContext?.targetBranch, {
        generatedName,
        signal: setup.signal,
      })
      controlPlane.setSessionGitEnvironment(sessionId, gitContext.worktreePath ?? cwd, gitContext)
      return { success: true, gitContext }
    } catch (err) {
      log.error('continue_in_worktree_failed', { error: err instanceof Error ? err.message : String(err) })
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create worktree' }
    } finally {
      if (pendingWorktreeSetups.get(sessionId) === setup) pendingWorktreeSetups.delete(sessionId)
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
