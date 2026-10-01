import { writeFile } from 'fs/promises'
import type { SessionRuntime } from '../../execution/session-runtime'
import type { IpcContext, GitCheckoutBranchResult } from '@solus/contracts/types'
import { discardChanges, syncWithOrigin, listBranches, listProjectWorktrees, getWorkingBranch, getDefaultBranch, buildCommitMessagePrompt, COMMIT_MESSAGE_SYSTEM_PROMPT } from '../../git/worktree-manager'
import { runGitAction } from '../../git/git-action-manager'
import { runAsync } from '../../git/exec'
import { GitUnavailableError } from '../../git/git-availability'
import { computeGitIdentity, computeGitState, resolveRepoRef, resolveRepoRoot } from '../../git/git-helpers'
import { getDiff, getDiffFileContents, getDiffStats, listTurnSnapshots } from '../../git/session-snapshots'
import { TextGenerator } from '../../execution/agents/text-generator'
import { createLogger } from '../../logger'
import { linkSessionPullRequest } from '../../data/sessions/session-pull-requests'
import { providerForRepo } from '../../providers/registry'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { prIndex } from '../../prs/pr-index'
import { pullRequestForBranch } from '../../prs/code-host'
import type { SolusServer } from '../server'
import { userKey } from '@solus/contracts/user'
import type { ActivityKind } from '@solus/contracts/activity'
import { WorkingTreeBusyError } from '../../execution/sessions/working-tree-busy'
import { attributionOf, seatFor } from '../../admission/actor'
import type { GitIdentityManager } from '../../git/git-identity-manager'
import type { HostEventPublisher } from '../events/host-event-publisher'
import { resolveSourceControlWritingPolicy } from '../../git/source-control-writing'
import { getHostConfig, resolveSourceControlWriterModel } from '../../host/settings'
import { writingBackendFor, type WritingBackend } from '../../execution/agents/writing-backend'

const log = createLogger('main', 'worktree-handlers')

/**
 * `continueInWorktree` setups in flight, per session. A superseding request
 * aborts the worktree creation it replaces, since a worktree for a superseded
 * request is one the user never asked for. Branch naming runs after the
 * worktree exists and is not part of the setup.
 *
 * Known gap: this is a second registry beside `SessionRuntime.pendingSetupControllers`,
 * which is what `stopSession` aborts. Stopping a session therefore does not
 * cancel a setup started here. Closing that means moving worktree provisioning
 * onto the SessionRuntime, which owns session lifecycle — deliberately out of
 * scope for a review fix.
 */
const pendingWorktreeSetups = new Map<string, AbortController>()

export interface WorktreeDeps {
  sessionRuntime: SessionRuntime
  events: HostEventPublisher
  gitIdentities: GitIdentityManager
}

/**
 * A context that names only its Solus session gets the provider thread and the
 * checkout from the session's lineage. Snapshots are stored under the provider
 * thread, and a surface with no tab — Insights opening a turn's change — knows
 * only the Solus id. The active lineage member answers: after a provider
 * handoff, turns from an earlier member are not reachable this way.
 */
function withSessionCheckout(ctx: IpcContext): IpcContext {
  if (ctx.session.agentSessionId || !ctx.session.sessionId) return ctx
  const active = resolveSessionLineageById(ctx.session.sessionId)?.active
  if (!active?.providerSessionId) return ctx
  return {
    ...ctx,
    session: {
      ...ctx.session,
      agentSessionId: active.providerSessionId,
      workingDirectory: ctx.session.workingDirectory || active.cwd,
    },
  }
}

async function resolveGitCheckout(ctx: IpcContext) {
  let gitContext = ctx.session.gitContext ?? undefined
  if (!gitContext && ctx.session.workingDirectory && ctx.session.workingDirectory !== '~') {
    const branch = await getWorkingBranch(ctx.session.workingDirectory)
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
  const { sessionRuntime } = deps
  server.register('checkoutSnapshot', ([paths]) => sessionRuntime.checkouts.snapshot(paths))
  const textGenerator = new TextGenerator(sessionRuntime)

  const generateCommitSubject = async (
    cwd: string,
    writer: WritingBackend | null,
    instructions: string,
  ) => {
    if (!writer) throw new Error('No Claude or Codex login on this host can write the commit message. Connect one, or write the message yourself.')
    return textGenerator.generate({
      provider: writer.provider,
      model: writer.model,
      seat: writer.seat,
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
  }

  server.register('worktreeListProject', (args) => {
    const [ctx] = args
    const dir = ctx.session.workingDirectory
    if (!dir || dir === '~') return []
    return listProjectWorktrees(dir)
  })

  server.register('diff', async (args) => {
    const ctx = withSessionCheckout(args[0])
    const request = args[1]
    log.info('rpc_diff', { sessionId: ctx.session.sessionId, scopeKind: request.scope.kind })
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return null
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return await getDiff(workTree, repoRoot, request.scope, sid, livePaths)
  })

  server.register('diffFileContents', async (args) => {
    const ctx = withSessionCheckout(args[0])
    const request = args[1]
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return null
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    return getDiffFileContents(workTree, repoRoot, sid, request)
  })

  server.register('diffStats', async (args) => {
    const ctx = withSessionCheckout(args[0])
    const request = args[1]
    const repoRoot = await checkoutRepoRoot(ctx)
    if (!repoRoot) return []
    const workTree = await workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return getDiffStats(workTree, repoRoot, request.scope, sid, livePaths)
  })

  server.register('listTurnSnapshots', async (args) => {
    const ctx = withSessionCheckout(args[0])
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
    if (!request.allowBusyWorkingTree) {
      const busy = sessionRuntime.busyWorkingTree(cwd, {
        sessionId: ctx.session.sessionId,
        clientId: handlerCtx.clientId,
        userId: handlerCtx.actor.user ? userKey(handlerCtx.actor.user.id) : null,
      })
      if (busy) {
        log.info('git_action_working_tree_busy', { sessionId: ctx.session.sessionId, runningSessionId: busy.sessionId })
        throw new WorkingTreeBusyError(busy.authorName)
      }
    }
    const policy = await resolveSourceControlWritingPolicy(
      cwd,
      getHostConfig().config.sourceControlWriting,
    )
    const writerBackend = await writingBackendFor(
      resolveSourceControlWriterModel(),
      (provider) => sessionRuntime.seatForTurn(handlerCtx.actor, provider),
    )
    const pullRequestRequested = request.action === 'create_pull_request'
      || request.action === 'commit_push_pull_request'
    const githubRepo = pullRequestRequested ? await resolveRepoRef(cwd) : null
    const githubProvider = githubRepo ? providerForRepo(githubRepo) : null
    const identity = await deps.gitIdentities.resolve(seatFor(handlerCtx.actor))
    const result = await runGitAction(request, gitContext, ctx.session.workingDirectory, {
      identity,
      holdIdentity: (held) => deps.gitIdentities.hold(held),
      writer: {
        backend: writerBackend,
        textGenerator,
        instructions: policy.pullRequestInstructions,
        followPullRequestTemplate: policy.followPullRequestTemplate,
      },
      generateCommitSubject: (targetCwd) => generateCommitSubject(
        targetCwd,
        writerBackend,
        policy.commitInstructions,
      ),
      findPullRequest: githubRepo && githubProvider
        ? async (branch) => await pullRequestForBranch({ repo: githubRepo, provider: githubProvider }, branch) ?? null
        : undefined,
      createPullRequest: githubRepo && githubProvider
        ? async (input) => {
          const pullRequest = await githubProvider.review.createPullRequest(githubRepo, {
            ...input,
            // The checkout's delegated credential leads, followed by the host
            // OAuth token and then the gh credential.
            credentialCwd: cwd,
          })
          prIndex.invalidate(githubRepo)
          return pullRequest
        }
        : undefined,
      publish: (event) => {
        // With no caller to answer, the session's watchers see the progress, not every member (plan 004 item 5).
        deps.events.publish(handlerCtx.clientId ?? sessionRuntime.clientsWatching(ctx.session.sessionId), 'git.actionProgressed', event)
      },
    })
    if (result.branch.status === 'created') {
      const nextGitContext = { ...gitContext, branch: result.branch.name }
      sessionRuntime.setSessionGitEnvironment(
        ctx.session.sessionId,
        nextGitContext.worktreePath ?? ctx.session.workingDirectory,
        nextGitContext,
      )
    }
    const pullRequest = result.pullRequest
    const sessionId = ctx.session.agentSessionId
    if (sessionId && pullRequest.status !== 'skipped' && pullRequest.url) {
      // Solus opened this pull request from the session, so the session owns
      // the link; its task, when it has one, reads it from there.
      await linkSessionPullRequest(sessionId, {
        url: pullRequest.url,
        source: 'created',
        by: attributionOf(handlerCtx.actor, { sessionId, provider: ctx.session.provider ?? undefined }),
      }).catch((error) => {
        log.warn('session_pr_link_failed', {
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
      const gitContext = (await sessionRuntime.checkouts.refresh(cwd)).checkout
      if (!gitContext) return { success: false, error: 'Checkout succeeded but branch status could not be resolved' }
      sessionRuntime.setSessionGitEnvironment(ctx.session.sessionId, cwd, gitContext)
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
      if (err instanceof GitUnavailableError) return
      log.warn('branch_fetch_before_list_failed', { error: err instanceof Error ? err.message : String(err) })
    })
    return listBranches(cwd, options)
  })

  server.register('worktreeRestore', async (args) => {
    const [ctx, worktreePath] = args
    log.info('rpc_worktree_restore', { sessionId: ctx.session.sessionId })
    const state = await sessionRuntime.checkouts.refresh(worktreePath)
    if (state.checkout) sessionRuntime.setSessionGitEnvironment(ctx.session.sessionId, worktreePath, state.checkout)
    return state.checkout
  })

  // Create a fresh worktree for a live session so it can "continue" there. The
  // renderer then flags the session to fork on its next prompt, re-homing the
  // conversation under the worktree. Eager creation (vs. the lazy worktree path)
  // gives us the branch name up front for the UI + git panel.
  server.register('continueInWorktree', async (args, handlerCtx) => {
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
      const gitContext = await sessionRuntime.checkouts.create(repoRoot, ctx.session.gitContext?.targetBranch, {
        signal: setup.signal,
      })
      sessionRuntime.setSessionGitEnvironment(sessionId, gitContext.worktreePath ?? cwd, gitContext)
      // Recorded before the branch is named: a reader resolves the checkout's current branch by its path.
      if (gitContext.worktreePath) {
        const moved: Extract<ActivityKind, { kind: 'moved_to_worktree' }> = { kind: 'moved_to_worktree', path: gitContext.worktreePath }
        const branch = gitContext.branch ?? gitContext.detachedHeadSha
        if (branch) moved.branch = branch
        await sessionRuntime.recordActivity({ kind: 'session', id: sessionId }, handlerCtx.actor, moved)
      }
      if (namePrompt) void sessionRuntime.nameWorktreeBranch(sessionId, gitContext, namePrompt, handlerCtx.actor)
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
    if (!options?.includeRefs) return computeGitState(cwd, options)
    // Refs ride along with the status scan so a full environment refresh is
    // one round trip. Same reads as `worktreeListProject` and `worktreeBranches`.
    const [state, worktrees, branches] = await Promise.all([
      computeGitState(cwd, options),
      Promise.resolve().then(() => listProjectWorktrees(cwd)),
      runAsync('git', ['fetch', '--all', '--prune'], cwd)
        .catch((err) => {
          if (err instanceof GitUnavailableError) return
          log.warn('branch_fetch_before_list_failed', { error: err instanceof Error ? err.message : String(err) })
        })
        .then(() => listBranches(cwd)),
    ])
    return state ? { ...state, refs: { worktrees, branches } } : null
  })

  server.register('gitIdentity', async ([cwd]) => computeGitIdentity(cwd))

  server.register('gitRegisterEnvironment', (args) => {
    const [ctx, cwd, gitContext] = args
    sessionRuntime.setSessionGitEnvironment(ctx.session.sessionId, cwd, gitContext)
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
