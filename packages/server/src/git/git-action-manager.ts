import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type {
  GitAction,
  GitActionPhase,
  GitActionProgressEvent,
  GitActionRequest,
  GitActionResult,
  GitCheckout,
} from '@solus/contracts/types'
import type { RepoRef } from '@solus/contracts/providers'
import { runAsync } from './exec'
import { toRootRelativePath } from '../paths'
import { authorPullRequest, type PullRequestWriter } from './pull-request-authoring'
import type { GitHubClient } from '../providers/github/octokit'
import { z } from 'zod'

export interface GitActionManagerOptions {
  writer: PullRequestWriter
  generateCommitSubject(cwd: string): Promise<string>
  githubClient?: GitHubClient | null
  githubRepo?: RepoRef | null
  githubToken?: string | null
  publish(event: GitActionProgressEvent): void
}

interface ExistingPullRequest {
  url: string
  number: number | null
  title: string
}

const activeActionCwds = new Set<string>()
const existingPullRequestSchema = z.object({
  url: z.string().min(1),
  number: z.number().nullable().catch(null),
  title: z.string().optional(),
})

function wantsCommit(action: GitAction): boolean {
  return action === 'commit' || action === 'commit_push' || action === 'commit_push_pull_request'
}

function wantsPullRequest(action: GitAction): boolean {
  return action === 'create_pull_request' || action === 'commit_push_pull_request'
}

function normalizeSelectedFilePaths(workTree: string, paths: string[]): string[] {
  if (paths.length === 0) throw new Error('Select at least one file to commit.')
  const seen = new Set<string>()
  for (const raw of paths) {
    const normalized = toRootRelativePath(workTree, raw)
    if (seen.has(normalized)) throw new Error(`Duplicate file selected: ${normalized}`)
    seen.add(normalized)
  }
  return [...seen]
}

function validateCommitMessage(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Commit message cannot be blank.')
  if (trimmed.length > 1000) throw new Error('Commit message is too long.')
  return trimmed
}

/** Paths `git status` reports as untracked (`??`), scoped to the given set —
 *  the only selected-file kind `git commit -- <pathspec>` can't see on its own. */
async function untrackedPathsAmong(cwd: string, paths: string[]): Promise<string[]> {
  const out = await runAsync('git', ['status', '--porcelain=v1', '--', ...paths], cwd)
  const untracked = new Set<string>()
  for (const line of out.split('\n')) {
    if (line.startsWith('?? ')) untracked.add(line.slice(3).trim())
  }
  return paths.filter((filePath) => untracked.has(filePath))
}

/**
 * Commits only the given paths, using Git's own pathspec-restricted commit
 * (the standard `-o`/`--only` mode Git enters whenever paths are given without
 * `-a`/`-i`): it reads each named path's current worktree content into a
 * throwaway tree, commits that, and updates the real index only for those
 * paths — every other staged or unstaged change is left exactly as it was.
 * Untracked paths must be staged first (`commit -- <pathspec>` otherwise
 * rejects them as unknown); on failure that staging is rolled back so the
 * repository ends up untouched.
 */
async function commitSelectedFiles(
  cwd: string,
  filePaths: string[],
  subject: string,
): Promise<GitActionResult['commit']> {
  const untracked = await untrackedPathsAmong(cwd, filePaths)
  if (untracked.length > 0) {
    await runAsync('git', ['add', '--', ...untracked], cwd)
  }
  try {
    await runAsync('git', ['commit', '-m', subject, '--', ...filePaths], cwd)
  } catch (error) {
    if (untracked.length > 0) {
      await runAsync('git', ['reset', '--', ...untracked], cwd).catch(() => {})
    }
    throw error
  }
  const sha = await runAsync('git', ['rev-parse', 'HEAD'], cwd)
  return { status: 'created', sha, subject }
}

function sanitizeCommitSubject(raw: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((value) => value.trim().replace(/^commit message:\s*/i, '').replace(/^['"`]+|['"`]+$/g, ''))
    .find(Boolean)
  return (line || 'chore: apply agent changes').replace(/[.]+$/, '').slice(0, 200).trimEnd()
}

function branchSlug(subject: string): string {
  const withoutConvention = subject.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, '')
  const slug = withoutConvention
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `feature/${slug || 'update'}`
}

async function uniqueBranchName(cwd: string, preferred: string): Promise<string> {
  const branches = (await runAsync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd))
    .split(/\r?\n/)
    .map((branch) => branch.trim())
    .filter(Boolean)
  if (!branches.includes(preferred)) return preferred
  let suffix = 2
  while (branches.includes(`${preferred}-${suffix}`)) suffix++
  return `${preferred}-${suffix}`
}

async function workingTreeIsDirty(cwd: string): Promise<boolean> {
  return !!(await runAsync('git', ['status', '--porcelain'], cwd))
}

async function hasUnmergedChanges(cwd: string): Promise<boolean> {
  return !!(await runAsync('git', ['diff', '--name-only', '--diff-filter=U'], cwd))
}

async function upstreamState(cwd: string): Promise<{ upstreamRef: string | null; aheadCount: number }> {
  const upstreamRef = await runAsync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd,
  ).catch(() => '')
  if (!upstreamRef) return { upstreamRef: null, aheadCount: 0 }
  const aheadCount = await runAsync('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], cwd)
    .then((value) => Number(value) || 0)
    .catch(() => 0)
  return { upstreamRef, aheadCount }
}

function ghEnv(githubToken?: string | null): NodeJS.ProcessEnv | undefined {
  return githubToken ? { GH_TOKEN: githubToken } : undefined
}

async function findExistingPullRequest(
  cwd: string,
  branch: string,
  githubToken?: string | null,
): Promise<ExistingPullRequest | null> {
  const raw = await runAsync(
    'gh',
    ['pr', 'view', branch, '--json', 'url,number,title'],
    cwd,
    { timeout: 10_000, env: ghEnv(githubToken) },
  ).catch(() => '')
  if (!raw) return null
  try {
    const parsed = existingPullRequestSchema.parse(JSON.parse(raw))
    return {
      url: parsed.url,
      number: parsed.number,
      title: parsed.title || branch,
    }
  } catch {
    return null
  }
}

async function branchHasPullRequestChanges(cwd: string, baseBranch: string): Promise<boolean> {
  const baseRef = await runAsync('git', ['rev-parse', '--verify', `origin/${baseBranch}`], cwd)
    .then(() => `origin/${baseBranch}`)
    .catch(() => baseBranch)
  const count = await runAsync('git', ['rev-list', '--count', `${baseRef}..HEAD`], cwd)
  return (Number(count) || 0) > 0
}

async function createPullRequest(
  cwd: string,
  baseBranch: string,
  headBranch: string,
  draft: { title: string; body: string },
  options: Pick<GitActionManagerOptions, 'githubClient' | 'githubRepo' | 'githubToken'>,
): Promise<ExistingPullRequest> {
  let octokitErrorMessage: string | null = null
  if (options.githubClient && options.githubRepo) {
    try {
      const { data } = await options.githubClient.rest.pulls.create({
        owner: options.githubRepo.owner,
        repo: options.githubRepo.repo,
        base: baseBranch,
        head: headBranch,
        title: draft.title,
        body: draft.body,
      })
      return {
        url: data.html_url,
        number: data.number,
        title: data.title,
      }
    } catch (error) {
      octokitErrorMessage = error instanceof Error ? error.message : String(error)
    }
  }

  const bodyFile = path.join(tmpdir(), `solus-pr-body-${process.pid}-${randomUUID()}.md`)
  await writeFile(bodyFile, draft.body, 'utf8')
  try {
    const output = await runAsync(
      'gh',
      ['pr', 'create', '--base', baseBranch, '--head', headBranch, '--title', draft.title, '--body-file', bodyFile],
      cwd,
      { env: ghEnv(options.githubToken) },
    )
    const url = output.match(/https:\/\/\S+/)?.[0] ?? output.trim()
    if (!url) throw new Error('GitHub did not return the pull request URL.')
    const numberMatch = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
    return {
      url,
      number: numberMatch ? Number(numberMatch[1]) : null,
      title: draft.title,
    }
  } catch (cliError) {
    if (!octokitErrorMessage) throw cliError
    const cliErrorMessage = cliError instanceof Error ? cliError.message : String(cliError)
    throw new Error(
      `Could not create the pull request with GitHub or the GitHub CLI. GitHub: ${octokitErrorMessage} GitHub CLI: ${cliErrorMessage}`,
    )
  } finally {
    await unlink(bodyFile).catch(() => {})
  }
}

async function runGitActionUnlocked(
  request: GitActionRequest,
  gitContext: GitCheckout,
  workingDirectory: string,
  options: GitActionManagerOptions,
): Promise<GitActionResult> {
  const cwd = gitContext.worktreePath || workingDirectory
  const initialBranch = gitContext.branch
  if (!initialBranch) throw new Error('Cannot run a Git action from detached HEAD.')

  const commitRequested = wantsCommit(request.action)
  const pullRequestRequested = wantsPullRequest(request.action)
  if ((request.commitMessage !== undefined || request.filePaths !== undefined) && !commitRequested) {
    throw new Error('A commit message or file selection is only valid for a commit action.')
  }
  const selectedFilePaths = request.filePaths !== undefined ? normalizeSelectedFilePaths(cwd, request.filePaths) : undefined
  const manualCommitMessage = request.commitMessage?.trim() ? validateCommitMessage(request.commitMessage) : undefined
  const initialDirty = await workingTreeIsDirty(cwd)
  if (commitRequested && !initialDirty) {
    throw new Error('There are no local changes to commit.')
  }
  if (commitRequested && await hasUnmergedChanges(cwd)) {
    throw new Error('Resolve merge conflicts before committing.')
  }
  if (request.action === 'push' && initialDirty) {
    throw new Error('Commit or discard local changes before pushing.')
  }
  if (request.action === 'create_pull_request' && initialDirty) {
    throw new Error('Commit local changes before creating a pull request.')
  }
  if (request.createFeatureBranch && !commitRequested) {
    throw new Error('A feature branch can only be created by an action that commits changes.')
  }
  if (request.createFeatureBranch && initialBranch !== gitContext.targetBranch) {
    throw new Error('A feature branch can only be created from the target branch.')
  }
  if (request.createFeatureBranch && !initialDirty) {
    throw new Error('There are no local changes to move to a feature branch.')
  }

  const initialUpstream = await upstreamState(cwd)
  const pushRequested = request.action === 'push'
    || request.action === 'commit_push'
    || request.action === 'commit_push_pull_request'
    || (request.action === 'create_pull_request'
      && (!initialUpstream.upstreamRef || initialUpstream.aheadCount > 0))
  const phases: GitActionPhase[] = [
    ...(request.createFeatureBranch ? ['branch' as const] : []),
    ...(commitRequested ? ['commit' as const] : []),
    ...(pushRequested ? ['push' as const] : []),
    ...(pullRequestRequested ? ['author_pull_request' as const, 'create_pull_request' as const] : []),
  ]
  const baseEvent = { actionId: request.actionId, cwd, action: request.action }
  options.publish({ ...baseEvent, kind: 'started', phases })

  let currentPhase: GitActionPhase | null = null
  try {
    let branch = initialBranch
    let generatedSubject: string | null = null
    let branchStep: GitActionResult['branch'] = { status: 'skipped' }
    if (request.createFeatureBranch) {
      currentPhase = 'branch'
      options.publish({ ...baseEvent, kind: 'phase_started', phase: currentPhase, label: 'Preparing feature branch…' })
      generatedSubject = sanitizeCommitSubject(await options.generateCommitSubject(cwd))
      branch = await uniqueBranchName(cwd, branchSlug(generatedSubject))
      await runAsync('git', ['checkout', '-b', branch], cwd)
      branchStep = { status: 'created', name: branch }
    }

    let commitStep: GitActionResult['commit'] = { status: 'skipped' }
    if (commitRequested) {
      currentPhase = 'commit'
      // Writing the message is the slow part of a commit, so it reports itself.
      const commitSubject = async (): Promise<string> => {
        const known = manualCommitMessage ?? generatedSubject
        if (known) return known
        options.publish({ ...baseEvent, kind: 'phase_started', phase: 'commit', label: 'Generating commit message…' })
        return sanitizeCommitSubject(await options.generateCommitSubject(cwd))
      }
      if (selectedFilePaths) {
        const subject = await commitSubject()
        options.publish({ ...baseEvent, kind: 'phase_started', phase: currentPhase, label: 'Committing…' })
        commitStep = await commitSelectedFiles(cwd, selectedFilePaths, subject)
      } else if (await workingTreeIsDirty(cwd)) {
        const subject = await commitSubject()
        options.publish({ ...baseEvent, kind: 'phase_started', phase: currentPhase, label: 'Committing…' })
        await runAsync('git', ['add', '-A'], cwd)
        await runAsync('git', ['commit', '-m', subject], cwd)
        const sha = await runAsync('git', ['rev-parse', 'HEAD'], cwd)
        commitStep = { status: 'created', sha, subject }
      } else {
        commitStep = { status: 'skipped_no_changes' }
      }
    }

    let pushStep: GitActionResult['push'] = { status: 'skipped' }
    if (pushRequested) {
      currentPhase = 'push'
      options.publish({ ...baseEvent, kind: 'phase_started', phase: currentPhase, label: 'Pushing…' })
      await runAsync('git', ['push', '-u', 'origin', branch], cwd)
      pushStep = { status: 'pushed', branch }
    }

    let pullRequestStep: GitActionResult['pullRequest'] = { status: 'skipped' }
    if (pullRequestRequested) {
      currentPhase = 'author_pull_request'
      options.publish({ ...baseEvent, kind: 'phase_started', phase: currentPhase, label: 'Writing pull request…' })
      const existing = await findExistingPullRequest(cwd, branch, options.githubToken)
      if (existing) {
        pullRequestStep = { status: 'existing', ...existing }
      } else {
        if (!(await branchHasPullRequestChanges(cwd, gitContext.targetBranch))) {
          throw new Error(`The ${branch} branch has no changes to open against ${gitContext.targetBranch}.`)
        }
        const draft = await authorPullRequest(cwd, gitContext.targetBranch, branch, options.writer)
        currentPhase = 'create_pull_request'
        options.publish({ ...baseEvent, kind: 'phase_started', phase: currentPhase, label: 'Creating pull request…' })
        pullRequestStep = {
          status: 'created',
          ...await createPullRequest(cwd, gitContext.targetBranch, branch, draft, options),
        }
      }
    }

    const result: GitActionResult = {
      action: request.action,
      branch: branchStep,
      commit: commitStep,
      push: pushStep,
      pullRequest: pullRequestStep,
    }
    options.publish({ ...baseEvent, kind: 'finished', result })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.publish({ ...baseEvent, kind: 'failed', phase: currentPhase, message })
    throw error
  }
}

export async function runGitAction(
  request: GitActionRequest,
  gitContext: GitCheckout,
  workingDirectory: string,
  options: GitActionManagerOptions,
): Promise<GitActionResult> {
  const cwd = gitContext.worktreePath || workingDirectory
  if (activeActionCwds.has(cwd)) {
    throw new Error('Another Git action is already running for this working tree.')
  }
  activeActionCwds.add(cwd)
  try {
    return await runGitActionUnlocked(request, gitContext, workingDirectory, options)
  } finally {
    activeActionCwds.delete(cwd)
  }
}
