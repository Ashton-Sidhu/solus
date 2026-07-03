import { writeFile } from 'fs/promises'
import type { ControlPlane } from '../../control-plane'
import { tabGitContextFromStatus, type IpcContext, type DiffRequest, type GitCheckoutBranchResult } from '../../../shared/types'
import { createPR, commitAndPushChanges, syncWithOrigin, listBranches, listProjectWorktrees, getWorkingBranch, getDefaultBranch, restoreWorktree, createWorktree, buildBranchNamePrompt, buildCommitMessagePrompt, COMMIT_MESSAGE_SYSTEM_PROMPT } from '../../git/worktree-manager'
import { runAsync } from '../../git/exec'
import { computeGitProjectStatus, resolveRepoRoot } from '../../git/git-helpers'
import { getDiff, getEpisodeNumstat, listTurnSnapshots } from '../../git/session-snapshots'
import { TextGenerator } from '../../agents/text-generator'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'

const log = createLogger('main', 'worktree-handlers')
const textGenerator = new TextGenerator()

export interface WorktreeDeps {
  controlPlane: ControlPlane
}

function resolveTabGitContext(ctx: IpcContext) {
  let gitContext = ctx.session.gitContext ?? undefined
  if (!gitContext && ctx.session.workingDirectory && ctx.session.workingDirectory !== '~') {
    const branch = getWorkingBranch(ctx.session.workingDirectory)
    const targetBranch = getDefaultBranch(ctx.session.workingDirectory)
    if (branch) {
      gitContext = { branch, targetBranch }
    }
  }
  return gitContext
}

function workTreeForCtx(ctx: IpcContext): string | null {
  const gitContext = resolveTabGitContext(ctx)
  return gitContext?.worktreePath || ctx.session.workingDirectory || null
}

async function repoRootForCtx(ctx: IpcContext): Promise<string | null> {
  const gitContext = resolveTabGitContext(ctx)
  const workTree = gitContext?.worktreePath || ctx.session.workingDirectory
  if (!workTree || workTree === '~') return null
  return resolveRepoRoot(workTree)
}

export function registerWorktreeHandlers(server: SolusServer, deps: WorktreeDeps): void {
  const { controlPlane } = deps

  server.register('worktreeListProject', (args) => {
    const [ctx] = args as [IpcContext]
    const dir = ctx.session.workingDirectory
    if (!dir || dir === '~') return []
    return listProjectWorktrees(dir)
  })

  server.register('diff', async (args) => {
    const [ctx, request] = args as [IpcContext, DiffRequest]
    log.info(`RPC diff: tab=${ctx.session.tabId} scope=${request.scope.kind}`)
    const repoRoot = await repoRootForCtx(ctx)
    if (!repoRoot) return null
    const workTree = workTreeForCtx(ctx)
    const sid = ctx.session.agentSessionId ?? null
    const livePaths = request.livePaths?.filter(Boolean) ?? []
    return await getDiff(workTree, repoRoot, request.scope, sid, livePaths)
  })

  // The Activity overview's changed-files list: per-file +/- counts only, via
  // numstat — so the rail never pays to transfer (and re-parse) the whole patch.
  server.register('prChangedFiles', async (args) => {
    const [ctx, baseSha] = args as [IpcContext, string]
    const repoRoot = await repoRootForCtx(ctx)
    const workTree = workTreeForCtx(ctx)
    if (!repoRoot || !workTree) return []
    return await getEpisodeNumstat(workTree, repoRoot, baseSha)
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
    log.info(`RPC worktreePR: tab=${ctx.session.tabId}`)
    if (!ctx.session.gitContext) return { success: false, error: 'No active git branch for this tab' }
    const cwd = ctx.session.gitContext.worktreePath || ctx.session.workingDirectory
    return createPR(ctx.session.gitContext, ctx.session.workingDirectory, {
      generateCommitMessage: (commitCwd) => textGenerator.generate({
        provider: ctx.session.provider ?? ctx.settings.activeAgent,
        model: ctx.statusBar.model,
        cwd: commitCwd,
        prompt: buildCommitMessagePrompt(commitCwd),
        systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
        disableReasoning: true,
        maxTurns: 1,
        timeoutMs: 30_000,
      }),
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
  })

  server.register('gitCommitPush', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info(`RPC gitCommitPush: tab=${ctx.session.tabId}`)
    const gitContext = resolveTabGitContext(ctx)
    if (!gitContext) return { success: false, error: 'No active git branch for this tab' }
    return commitAndPushChanges(gitContext, ctx.session.workingDirectory, {
      generateCommitMessage: (cwd) => textGenerator.generate({
        provider: ctx.session.provider ?? ctx.settings.activeAgent,
        model: ctx.statusBar.model,
        cwd,
        prompt: buildCommitMessagePrompt(cwd),
        systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
        disableReasoning: true,
        maxTurns: 1,
        timeoutMs: 30_000,
      }),
    })
  })

  server.register('gitSync', async (args) => {
    const [ctx] = args as [IpcContext]
    log.info(`RPC gitSync: tab=${ctx.session.tabId}`)
    const gitContext = resolveTabGitContext(ctx)
    if (!gitContext) return { success: false, error: 'No active git branch for this tab' }
    return syncWithOrigin(gitContext, ctx.session.workingDirectory)
  })

  server.register('gitCheckoutBranch', async (args): Promise<GitCheckoutBranchResult> => {
    const [ctx, branch] = args as [IpcContext, string]
    log.info(`RPC gitCheckoutBranch: tab=${ctx.session.tabId} branch=${branch}`)
    const cwd = ctx.session.workingDirectory
    if (!cwd || cwd === '~') return { success: false, error: 'No active git repository for this tab' }
    if (!branch || !listBranches(cwd).includes(branch)) {
      return { success: false, error: `Branch not found: ${branch}` }
    }
    try {
      await runAsync('git', ['checkout', branch], cwd)
      const gitContext = tabGitContextFromStatus(await computeGitProjectStatus(cwd))
      if (!gitContext) return { success: false, error: 'Checkout succeeded but branch status could not be resolved' }
      controlPlane.setTabGitContext(ctx.session.tabId, gitContext)
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
      log.warn(`Failed to fetch branches before listing: ${err?.message ?? err}`)
    })
    return listBranches(cwd)
  })

  server.register('worktreeRestore', (args) => {
    const [ctx, worktreePath, options] = args as [IpcContext, string, { includePr?: boolean } | undefined]
    log.info(`RPC worktreeRestore: tab=${ctx.session.tabId}`)
    if (ctx.session.gitContext?.worktreePath && ctx.session.gitContext.worktreePath === worktreePath) {
      controlPlane.setTabGitContext(ctx.session.tabId, ctx.session.gitContext)
      return ctx.session.gitContext
    }
    const gitContext = restoreWorktree(worktreePath, options)
    if (gitContext) controlPlane.setTabGitContext(ctx.session.tabId, gitContext)
    return gitContext
  })

  // Create a fresh worktree for a live session so it can "continue" there. The
  // renderer then flags the session to fork on its next prompt, re-homing the
  // conversation under the worktree. Eager creation (vs. the lazy worktree path)
  // gives us the branch name up front for the UI + git panel.
  server.register('continueInWorktree', async (args) => {
    const [ctx, namePrompt] = args as [IpcContext, string | undefined]
    log.info(`RPC continueInWorktree: tab=${ctx.session.tabId}`)
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
      controlPlane.setTabGitContext(ctx.session.tabId, gitContext)
      return { success: true, gitContext }
    } catch (err: any) {
      log.error(`continueInWorktree failed: ${err?.message}`)
      return { success: false, error: err?.message ?? 'Failed to create worktree' }
    }
  })

  server.register('gitProjectStatus', async (args) => {
    const [cwd] = args as [string]
    return computeGitProjectStatus(cwd)
  })

  server.register('writePlanFile', async (args) => {
    const [filePath, content] = args as [string, string]
    try {
      await writeFile(filePath, content, 'utf-8')
      log.info(`RPC writePlanFile: wrote ${content.length} chars to ${filePath}`)
      return { ok: true }
    } catch (err: any) {
      log.error(`RPC writePlanFile: failed to write ${filePath}: ${err?.message}`)
      return { ok: false, error: err?.message ?? String(err) }
    }
  })
}
