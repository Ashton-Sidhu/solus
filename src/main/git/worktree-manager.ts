import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import path from 'path'
import { SOLUS_WORKTREE_DIR, isSolusWorktreePath, worktreeProjectRoot, type GitCommitPushResult, type GitSyncResult, type TabGitContext, type WorktreeEntry, type WorktreePRResult } from '../../shared/types'
import { createLogger } from '../logger'
import { git, runAsync } from './exec'
import { generatePullRequestDraft } from './pr-draft'

const log = createLogger('WorktreeManager', 'worktree-manager.ts')

const MAX_COMMIT_DIFF_CHARS = 20_000

export const COMMIT_MESSAGE_SYSTEM_PROMPT = [
  'You write concise git commit messages.',
  'Return exactly one commit subject line and nothing else.',
  'Do not include any reasoning, preamble, explanation, or restatement of the task — output only the subject line.',
  'Use conventional commit style when the change clearly fits.',
  'Keep it under 72 characters.',
  'Do not wrap the response in quotes or markdown.',
].join('\n')

export function buildBranchNamePrompt(taskText: string): string {
  return [
    'Summarize the input into a worktree name.',
    'Return exactly one line: 2-4 words in kebab-case describing the core change.',
    'Do not explain, reason, acknowledge, mention the task, or include any other text.',
    'Focus on the distinctive part of the task, not generic words like "implement", "plan", or "fix".',
    'Lowercase only. No prefixes, no quotes, no markdown.',
    'Examples: dark-mode-toggle, auth-redirect-loop, rename-worktrees',
    'Folow these instructions exactly, no exceptions.',
    taskText
  ].join('\n')
}

export function getHeadCommit(cwd: string): string | null {
  try {
    return git(['rev-parse', 'HEAD'], cwd)
  } catch {
    return null
  }
}

export function getDefaultBranch(cwd: string): string {
  try {
    const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    return ref.replace('origin/', '')
  } catch {
    try {
      const remote = git(['remote', 'show', 'origin'], cwd)
      const match = remote.match(/HEAD branch:\s*(\S+)/)
      if (match?.[1] && match[1] !== '(unknown)') return match[1]
    } catch {}
    try {
      git(['rev-parse', '--verify', 'main'], cwd)
      return 'main'
    } catch {
      return 'master'
    }
  }
}

export function getWorkingBranch(cwd: string): string | null {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  } catch {
    return null
  }
}


function slugifyBranch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** Pull a branch slug out of a model response, ignoring quotes/markdown/extra lines. */
function sanitizeBranchSlug(raw: string): string {
  const candidates = raw
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith('```'))
    .map((value) => slugifyBranch(value.replace(/^["'`]+|["'`]+$/g, '')))
    .filter(Boolean)

  return candidates.find((value) => /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(value)) ?? candidates[0] ?? ''
}

function branchFromSlug(slug: string): string {
  const short = Math.random().toString(36).slice(2, 7)
  return `solus/${slug || 'task'}-${short}`
}

export interface CreateWorktreeOptions {
  /** Optional model-backed namer; falls back to a prompt slug when absent or on failure. */
  generateName?: (prompt: string) => Promise<string>
}

async function resolveBranchName(prompt: string, options: CreateWorktreeOptions): Promise<string> {
  if (options.generateName) {
    try {
      const slug = sanitizeBranchSlug(await options.generateName(prompt))
      if (slug) return branchFromSlug(slug)
    } catch (e) {
      log.warn(`Branch name generation failed, falling back to prompt slug: ${e}`)
    }
  }
  return branchFromSlug(slugifyBranch(prompt))
}

export async function createWorktree(
  projectPath: string,
  prompt: string,
  baseBranch?: string,
  options: CreateWorktreeOptions = {},
): Promise<TabGitContext> {
  const targetBranch = baseBranch || getDefaultBranch(projectPath)
  const branch = await resolveBranchName(prompt, options)
  const worktreePath = path.join(projectPath, SOLUS_WORKTREE_DIR, branch.replace(/\//g, '-'))

  log.info(`Creating worktree: ${branch} at ${worktreePath}`)
  git(['worktree', 'add', '-b', branch, worktreePath, targetBranch], projectPath)
  copyIncludedWorktreeFiles(projectPath, worktreePath)

  return { branch, targetBranch, worktreePath }
}

function copyIncludedWorktreeFiles(projectPath: string, worktreePath: string): void {
  const includePath = path.join(projectPath, '.worktreeinclude')
  if (!existsSync(includePath)) return

  const ignoredFiles = git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], projectPath)
    .split('\0')
    .filter(Boolean)
  if (ignoredFiles.length === 0) return

  const ignoredFileSet = new Set(ignoredFiles)
  const matchedFiles = git(['ls-files', '--others', '--ignored', `--exclude-from=${includePath}`, '-z'], projectPath)
    .split('\0')
    .filter((relativePath) => relativePath && ignoredFileSet.has(relativePath))

  for (const relativePath of matchedFiles) {
    const source = path.join(projectPath, relativePath)
    const target = path.join(worktreePath, relativePath)
    if (!statSync(source).isFile()) continue

    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
  }
}

export function buildCommitMessagePrompt(cwd: string): string {
  const status = git(['status', '--porcelain'], cwd)
  const stat = git(['diff', '--stat'], cwd)
  const stagedStat = git(['diff', '--cached', '--stat'], cwd)
  const diff = [
    git(['diff', '--no-ext-diff', '--unified=3'], cwd),
    git(['diff', '--cached', '--no-ext-diff', '--unified=3'], cwd),
  ].filter(Boolean).join('\n\n').slice(0, MAX_COMMIT_DIFF_CHARS)

  return [
    COMMIT_MESSAGE_SYSTEM_PROMPT,
    '',
    'Git status:',
    status || '(clean)',
    '',
    'Diff stat:',
    [stat, stagedStat].filter(Boolean).join('\n') || '(none)',
    '',
    'Diff:',
    diff || '(none)',
  ].join('\n')
}

export interface CommitMessageOptions {
  generateCommitMessage?: (cwd: string) => Promise<string>
  generatePRText?: (prompt: string) => Promise<string>
}

async function commitPendingChanges(cwd: string, fallbackMessage: string, options: CommitMessageOptions = {}): Promise<void> {
  const status = await runAsync('git', ['status', '--porcelain'], cwd)
  if (!status) return
  const message = options.generateCommitMessage
    ? sanitizeCommitMessage(await options.generateCommitMessage(cwd)) ?? fallbackMessage
    : fallbackMessage
  await runAsync('git', ['add', '-A'], cwd)
  await runAsync('git', ['commit', '-m', message], cwd)
}

/** Reasoning/preamble the model sometimes leaks into its text output instead of a bare subject. */
const REASONING_PREAMBLE = /^(the user\b|let me\b|let'?s\b|i'?ll\b|i will\b|i'?m\b|i am\b|here'?s\b|here is\b|okay\b|sure\b|based on\b|looking at\b|first,? )/i

function sanitizeCommitMessage(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith('```'))
    .map((value) =>
      value
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^commit message:\s*/i, '')
        .trim(),
    )
    .filter(Boolean)
  if (lines.length === 0) return null

  // A real subject is a single short line; leaked reasoning shows up as a meta
  // opener or a long multi-sentence paragraph. Prefer a conventional-commit line,
  // otherwise the last line that doesn't look like prose. If everything looks like
  // reasoning, return null so the caller falls back to its default message.
  const isProse = (line: string) =>
    REASONING_PREAMBLE.test(line) || (line.length > 80 && /[.?!]\s+\S/.test(line))
  const candidate =
    lines.find((line) => /^[a-z]+(\([^)]+\))?!?:\s/.test(line)) ??
    [...lines].reverse().find((line) => !isProse(line))
  if (!candidate) return null
  return candidate.slice(0, 200) || null
}

export async function createPR(
  gitContext: TabGitContext,
  workingDirectory: string,
  options: CommitMessageOptions = {},
): Promise<WorktreePRResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    const existingUrl = await getExistingPR(gitContext.branch, cwd)
    if (existingUrl) return { success: true, url: existingUrl }

    await commitPendingChanges(cwd, 'chore: apply agent changes', options)

    await runAsync('git', ['push', '-u', 'origin', gitContext.branch], cwd)

    const draft = options?.generatePRText
      ? await generatePullRequestDraft({
          cwd,
          baseBranch: gitContext.targetBranch,
          headBranch: gitContext.branch,
          generateText: options.generatePRText,
        })
      : null

    const result = draft
      ? await runAsync('gh', [
          'pr', 'create',
          '--base', gitContext.targetBranch,
          '--head', gitContext.branch,
          '--title', draft.title,
          '--body', draft.body,
        ], cwd)
      : await runAsync('gh', [
          'pr', 'create',
          '--base', gitContext.targetBranch,
          '--head', gitContext.branch,
          '--fill',
        ], cwd)

    const urlMatch = result.match(/https:\/\/github\.com\/\S+/)
    return { success: true, url: urlMatch?.[0] || result }
  } catch (e: any) {
    return { success: false, error: String(e.message || e) }
  }
}

export async function commitAndPushChanges(
  gitContext: TabGitContext,
  workingDirectory: string,
  options: CommitMessageOptions = {},
): Promise<GitCommitPushResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    await commitPendingChanges(cwd, 'chore: apply agent changes', options)
    const branch = gitContext.branch || getWorkingBranch(cwd)
    if (!branch) return { success: false, error: 'No active git branch for this tab' }
    await runAsync('git', ['push', '-u', 'origin', branch], cwd)
    return { success: true }
  } catch (e: any) {
    return { success: false, error: String(e.message || e) }
  }
}

export async function syncWithOrigin(
  gitContext: TabGitContext,
  workingDirectory: string,
): Promise<GitSyncResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    if (gitContext.worktreePath) {
      await runAsync('git', ['pull', 'origin', gitContext.targetBranch], cwd)
      log.info(`Synced worktree with origin/${gitContext.targetBranch}`)
    } else {
      await runAsync('git', ['pull'], cwd)
      log.info(`Synced with origin/${gitContext.branch}`)
    }

    return { success: true }
  } catch (e: any) {
    return { success: false, error: String(e.message || e) }
  }
}

export async function getExistingPR(branch: string, cwd: string): Promise<string | null> {
  try {
    const url = await runAsync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], cwd, { timeout: 10_000 })
    return url || null
  } catch {
    return null
  }
}

export function restoreWorktree(worktreePath: string, _options?: { includePr?: boolean }): TabGitContext | null {
  if (!isSolusWorktreePath(worktreePath)) return null

  try {
    const branch = getWorkingBranch(worktreePath)
    if (!branch) return null

    const projectPath = worktreeProjectRoot(worktreePath)
    const targetBranch = getDefaultBranch(projectPath)
    log.info(`Restored worktree: ${branch} at ${worktreePath}`)
    return { branch, targetBranch, worktreePath }
  } catch (e) {
    log.error(`Failed to restore worktree: ${e}`)
    return null
  }
}

export function listBranches(projectPath: string): string[] {
  try {
    const output = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], projectPath)
    const branches = new Set<string>()
    for (const ref of output.split('\n').filter(Boolean)) {
      if (ref.startsWith('refs/heads/')) {
        branches.add(ref.slice('refs/heads/'.length))
        continue
      }
      if (!ref.startsWith('refs/remotes/')) continue
      const remoteBranch = ref.slice('refs/remotes/'.length)
      if (remoteBranch.endsWith('/HEAD')) continue
      branches.add(remoteBranch.replace(/^[^/]+\//, ''))
    }
    return Array.from(branches)
  } catch {
    return []
  }
}

export interface PrWorktree {
  worktreePath: string
  /** Local review branch, e.g. `solus/pr-42`. */
  branch: string
  /** merge-base(base, head) — diff base + companion episode base. */
  baseSha: string
  /** PR head commit now checked out — the comment anchor. */
  headSha: string
}

/**
 * Fetch a PR's head into a dedicated worktree+branch (`.solus-worktrees/pr-N` on
 * `solus/pr-N`) and report the merge-base the diff/companion anchor to. `pull/N/head`
 * retrieves the PR's commits even from a fork without adding the fork as a remote —
 * this is how we check out other people's PRs. Reused on reopen and fast-forwarded
 * on refresh; a diverged/dirty worktree (agent work) is left untouched.
 */
export async function fetchAndCheckoutPr(
  projectPath: string,
  prNumber: number,
  baseRef: string,
): Promise<PrWorktree> {
  const branch = `solus/pr-${prNumber}`
  const worktreePath = path.join(projectPath, SOLUS_WORKTREE_DIR, `pr-${prNumber}`)

  await runAsync('git', ['fetch', 'origin', `pull/${prNumber}/head`], projectPath)
  const headSha = await runAsync('git', ['rev-parse', 'FETCH_HEAD'], projectPath)

  const existing = listProjectWorktrees(projectPath).find(
    (w) => w.path === worktreePath || w.branch === branch,
  )
  if (existing) {
    log.info(`Reusing PR worktree ${branch} at ${existing.path}`)
    // Fast-forward to the freshly fetched head when it can apply cleanly; never
    // clobber local agent work (a non-ff or dirty tree is left as-is).
    await runAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], existing.path).catch(() => {})
  } else {
    log.info(`Creating PR worktree ${branch} at ${worktreePath}`)
    git(['worktree', 'add', '-b', branch, worktreePath, 'FETCH_HEAD'], projectPath)
    copyIncludedWorktreeFiles(projectPath, worktreePath)
  }

  // Ensure the base ref is present locally, then anchor the diff at the divergence point.
  await runAsync('git', ['fetch', 'origin', baseRef], projectPath).catch(() => {})
  const baseSha = await runAsync('git', ['merge-base', headSha, `origin/${baseRef}`], projectPath).catch(
    () => headSha,
  )

  return { worktreePath: existing?.path ?? worktreePath, branch, baseSha, headSha }
}

export function listProjectWorktrees(projectPath: string): WorktreeEntry[] {
  try {
    const output = git(['worktree', 'list', '--porcelain'], projectPath)
    const entries: Array<{ path?: string; branch?: string; isBare?: boolean }> = []
    let current: { path?: string; branch?: string; isBare?: boolean } = {}

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current)
        current = { path: line.slice(9), branch: '', isBare: false }
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      } else if (line === 'bare') {
        current.isBare = true
      } else if (line === '') {
        if (current.path) entries.push(current)
        current = {}
      }
    }
    if (current.path) entries.push(current)

    return entries
      .filter((e): e is { path: string; branch: string; isBare: boolean } => !e.isBare && !!e.branch && !!e.path && existsSync(e.path))
      .map(e => {
        let lastModified: number | undefined
        try { lastModified = statSync(e.path).mtimeMs } catch { /* ignore */ }
        return { path: e.path, branch: e.branch, lastModified }
      })
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
  } catch {
    return []
  }
}
