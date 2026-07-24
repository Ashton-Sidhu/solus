import { existsSync, statSync } from 'fs'
import { copyFile, mkdir, stat as fsStat } from 'fs/promises'
import path from 'path'
import { SOLUS_WORKTREE_DIR, isSolusWorktreePath, worktreeProjectRoot, type GitCheckout, type GitCommitPushResult, type GitSyncResult, type WorktreeEntry, type WorktreePRResult } from '../../shared/types'
import { createLogger } from '../logger'
import { git, runAsync } from './exec'
import { generatePullRequestDraft } from './pr-draft'

const log = createLogger('WorktreeManager', 'worktree-manager.ts')

const MAX_COMMIT_DIFF_CHARS = 20_000
/** Cap the raw diff spawn so a huge working tree can't blow up memory; we slice to
 *  MAX_COMMIT_DIFF_CHARS afterward anyway, and treat an oversized diff as empty. */
const MAX_COMMIT_DIFF_BYTES = 2_000_000

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

// The default branch is fixed for a repo's lifetime, but resolving it can hit the
// network: a repo not created by `git clone` has no local `origin/HEAD`, so we fall
// back to `git ls-remote`. Cache per cwd — storing the in-flight promise dedupes
// concurrent callers and the resolved value is reused for the process lifetime — so
// the network probe happens at most once. Status summaries still need the target
// branch on every prompt dispatch / watcher fire, so hot callers then pay nothing.
const defaultBranchCache = new Map<string, string | Promise<string>>()

async function resolveDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await runAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    return ref.replace('origin/', '')
  } catch {}
  try {
    // Lighter than `git remote show origin`: a single symref round-trip.
    const symref = await runAsync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], cwd)
    const match = symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)
    if (match?.[1]) return match[1]
  } catch {}
  try {
    await runAsync('git', ['rev-parse', '--verify', 'main'], cwd)
    return 'main'
  } catch {
    return 'master'
  }
}

export function getDefaultBranch(cwd: string): Promise<string> {
  const cached = defaultBranchCache.get(cwd)
  if (cached) return Promise.resolve(cached)
  const pending = resolveDefaultBranch(cwd).then((branch) => {
    defaultBranchCache.set(cwd, branch)
    return branch
  })
  defaultBranchCache.set(cwd, pending)
  return pending
}

/** Local-only default-branch resolution for status refreshes. This deliberately
 * avoids `ls-remote` so opening a project never waits on the network. Local
 * fallbacks are not cached because a later remote-aware lookup may discover a
 * different default branch. */
export async function getDefaultBranchLocal(cwd: string): Promise<string> {
  const cached = defaultBranchCache.get(cwd)
  if (typeof cached === 'string') return cached
  try {
    const ref = await runAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    const branch = ref.replace('origin/', '')
    defaultBranchCache.set(cwd, branch)
    return branch
  } catch {}
  try {
    await runAsync('git', ['rev-parse', '--verify', 'main'], cwd)
    return 'main'
  } catch {
    return 'master'
  }
}

/** Synchronous, local-only default-branch resolution for `restoreWorktree`, which
 *  returns a plain value by contract. Reuses a warm cache entry when the async
 *  resolver already ran for this cwd; otherwise reads LOCAL refs only (never the
 *  network) and falls back to main/master. */
function getDefaultBranchLocalSync(cwd: string): string {
  const cached = defaultBranchCache.get(cwd)
  if (typeof cached === 'string') return cached
  try {
    const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    return ref.replace('origin/', '')
  } catch {}
  try {
    git(['rev-parse', '--verify', 'main'], cwd)
    return 'main'
  } catch {
    return 'master'
  }
}

export function getWorkingBranch(cwd: string): string | null {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    return branch === 'HEAD' ? null : branch
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

async function resolveWorktreeStartPoint(projectPath: string, targetBranch: string): Promise<string> {
  const remoteRef = `origin/${targetBranch}`
  try {
    await runAsync('git', ['fetch', 'origin', targetBranch], projectPath)
    await runAsync('git', ['rev-parse', '--verify', remoteRef], projectPath)
    return remoteRef
  } catch (e) {
    log.warn(`Falling back to local ${targetBranch} for worktree start point: ${e}`)
    return targetBranch
  }
}

export async function createWorktree(
  projectPath: string,
  prompt: string,
  baseBranch?: string,
  options: CreateWorktreeOptions = {},
): Promise<GitCheckout> {
  const targetBranch = baseBranch || await getDefaultBranch(projectPath)
  const startPoint = await resolveWorktreeStartPoint(projectPath, targetBranch)
  const branch = await resolveBranchName(prompt, options)
  const worktreePath = path.join(projectPath, SOLUS_WORKTREE_DIR, branch.replace(/\//g, '-'))

  log.info(`Creating worktree: ${branch} at ${worktreePath} from ${startPoint}`)
  await runAsync('git', ['worktree', 'add', '-b', branch, worktreePath, startPoint], projectPath)
  await copyIncludedWorktreeFiles(projectPath, worktreePath)

  return { branch, targetBranch, worktreePath, repoRoot: projectPath }
}

async function copyIncludedWorktreeFiles(projectPath: string, worktreePath: string): Promise<void> {
  const includePath = path.join(projectPath, '.worktreeinclude')
  if (!existsSync(includePath)) return

  const ignoredFiles = (await runAsync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], projectPath))
    .split('\0')
    .filter(Boolean)
  if (ignoredFiles.length === 0) return

  const ignoredFileSet = new Set(ignoredFiles)
  const matchedFiles = (await runAsync('git', ['ls-files', '--others', '--ignored', `--exclude-from=${includePath}`, '-z'], projectPath))
    .split('\0')
    .filter((relativePath) => relativePath && ignoredFileSet.has(relativePath))

  for (const relativePath of matchedFiles) {
    const source = path.join(projectPath, relativePath)
    const target = path.join(worktreePath, relativePath)
    if (!(await fsStat(source)).isFile()) continue

    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
  }
}

/** A full unified diff can be enormous; cap the buffer and treat an oversized diff
 *  as empty (status + --stat still inform the message) rather than throwing. */
async function safeCommitDiff(args: string[], cwd: string): Promise<string> {
  try {
    return await runAsync('git', args, cwd, { maxBuffer: MAX_COMMIT_DIFF_BYTES })
  } catch (err: any) {
    if (err?.code === 'ENOBUFS') return ''
    throw err
  }
}

export async function buildCommitMessagePrompt(cwd: string): Promise<string> {
  const status = await runAsync('git', ['status', '--porcelain'], cwd)
  const stat = await runAsync('git', ['diff', '--stat'], cwd)
  const stagedStat = await runAsync('git', ['diff', '--cached', '--stat'], cwd)
  const diff = [
    await safeCommitDiff(['diff', '--no-ext-diff', '--unified=3'], cwd),
    await safeCommitDiff(['diff', '--cached', '--no-ext-diff', '--unified=3'], cwd),
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

async function commitPendingChanges(cwd: string, fallbackMessage: string, options: CommitMessageOptions = {}): Promise<boolean> {
  const status = await runAsync('git', ['status', '--porcelain'], cwd)
  if (!status) return false
  const message = options.generateCommitMessage
    ? sanitizeCommitMessage(await options.generateCommitMessage(cwd)) ?? fallbackMessage
    : fallbackMessage
  await runAsync('git', ['add', '-A'], cwd)
  await runAsync('git', ['commit', '-m', message], cwd)
  return true
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
  gitContext: GitCheckout,
  workingDirectory: string,
  options: CommitMessageOptions = {},
): Promise<WorktreePRResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    const branch = gitContext.branch
    if (!branch) return { success: false, error: 'Cannot create a pull request from detached HEAD' }
    const existingUrl = await getExistingPR(branch, cwd)
    if (existingUrl) return { success: true, url: existingUrl }

    await commitPendingChanges(cwd, 'chore: apply agent changes', options)

    await runAsync('git', ['push', '-u', 'origin', branch], cwd)

    const draft = options?.generatePRText
      ? await generatePullRequestDraft({
          cwd,
          baseBranch: gitContext.targetBranch,
          headBranch: branch,
          generateText: options.generatePRText,
        })
      : null

    const result = draft
      ? await runAsync('gh', [
          'pr', 'create',
          '--base', gitContext.targetBranch,
          '--head', branch,
          '--title', draft.title,
          '--body', draft.body,
        ], cwd)
      : await runAsync('gh', [
          'pr', 'create',
          '--base', gitContext.targetBranch,
          '--head', branch,
          '--fill',
        ], cwd)

    const urlMatch = result.match(/https:\/\/github\.com\/\S+/)
    return { success: true, url: urlMatch?.[0] || result }
  } catch (e: any) {
    return { success: false, error: String(e.message || e) }
  }
}

export async function commitAndPushChanges(
  gitContext: GitCheckout,
  workingDirectory: string,
  options: CommitMessageOptions = {},
): Promise<GitCommitPushResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  let committed = false
  try {
    committed = await commitPendingChanges(cwd, 'chore: apply agent changes', options)
    const branch = gitContext.branch
    if (!branch) return { success: false, outcome: committed ? 'committed-only' : 'failed', committed, pushed: false, error: 'No active git branch for this tab' }
    await runAsync('git', ['push', '-u', 'origin', branch], cwd)
    return { success: true, outcome: committed ? 'pushed' : 'unchanged', committed, pushed: true }
  } catch (e: any) {
    return { success: false, outcome: committed ? 'committed-only' : 'failed', committed, pushed: false, error: String(e.message || e) }
  }
}

export async function syncWithOrigin(
  gitContext: GitCheckout,
  workingDirectory: string,
): Promise<GitSyncResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    if (gitContext.worktreePath) {
      await runAsync('git', ['pull', '--no-edit', 'origin', gitContext.targetBranch], cwd)
      log.info(`Synced worktree with origin/${gitContext.targetBranch}`)
    } else {
      await runAsync('git', ['pull', '--no-edit'], cwd)
      log.info(`Synced with origin/${gitContext.branch}`)
    }

    return { success: true, outcome: 'synced' }
  } catch (e: any) {
    const conflicted = await runAsync('git', ['diff', '--name-only', '--diff-filter=U'], cwd).catch(() => '')
    return { success: false, outcome: conflicted ? 'conflicted' : 'failed', error: String(e.message || e) }
  }
}

const EXISTING_PR_TTL_MS = 60_000
const existingPrCache = new Map<string, { at: number; url: Promise<string | null> }>()

/** `gh pr view` is a network call used by detailed status consumers. TTL-cache
 *  the result per (cwd, branch) for both hits and misses, and share the in-flight
 *  promise so multiple visible clients collapse to a single spawn. */
export function getExistingPR(branch: string, cwd: string, bypassCache = false): Promise<string | null> {
  const key = `${cwd}\0${branch}`
  if (bypassCache) existingPrCache.delete(key)
  const cached = existingPrCache.get(key)
  if (cached && Date.now() - cached.at < EXISTING_PR_TTL_MS) return cached.url
  const url = (async () => {
    try {
      const result = await runAsync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], cwd, { timeout: 10_000 })
      return result || null
    } catch {
      return null
    }
  })()
  existingPrCache.set(key, { at: Date.now(), url })
  return url
}

export function restoreWorktree(worktreePath: string, _options?: { includePr?: boolean }): GitCheckout | null {
  if (!isSolusWorktreePath(worktreePath)) return null

  try {
    const branch = getWorkingBranch(worktreePath)
    if (!branch) return null

    const projectPath = worktreeProjectRoot(worktreePath)
    const targetBranch = getDefaultBranchLocalSync(projectPath)
    log.info(`Restored worktree: ${branch} at ${worktreePath}`)
    return { branch, targetBranch, worktreePath, repoRoot: projectPath }
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
    const branchExists = await runAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], projectPath).then(
      () => true,
      () => false,
    )
    if (branchExists) {
      await runAsync('git', ['worktree', 'add', worktreePath, branch], projectPath)
      await runAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], worktreePath).catch(() => {})
    } else {
      await runAsync('git', ['worktree', 'add', '-b', branch, worktreePath, 'FETCH_HEAD'], projectPath)
    }
    await copyIncludedWorktreeFiles(projectPath, worktreePath)
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
