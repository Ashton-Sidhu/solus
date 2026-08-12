import { existsSync, statSync } from 'fs'
import { copyFile, mkdir, stat as fsStat } from 'fs/promises'
import path from 'path'
import { SOLUS_WORKTREE_DIR, isSolusWorktreePath, worktreeProjectRoot, type GitCheckout, type GitCommitPushResult, type GitCommitResult, type GitDiscardResult, type GitSyncResult, type WorktreeEntry, type WorktreePRResult } from '../../shared/types'
import { createLogger } from '../logger'
import { git, runAsync } from './exec'

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

function branchFromSlug(slug: string): string {
  const short = Math.random().toString(36).slice(2, 7)
  return `solus/${slug || 'task'}-${short}`
}

export interface CreateWorktreeOptions {
  /** Cancels branch discovery and worktree creation with the owning setup. */
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Interrupted')
}

async function resolveWorktreeStartPoint(
  projectPath: string,
  targetBranch: string,
  signal?: AbortSignal,
): Promise<string> {
  const remoteRef = `origin/${targetBranch}`
  try {
    await runAsync('git', ['fetch', 'origin', targetBranch], projectPath, { signal })
    await runAsync('git', ['rev-parse', '--verify', remoteRef], projectPath, { signal })
    return remoteRef
  } catch (e) {
    throwIfAborted(signal)
    log.warn('worktree_start_point_fallback_local', { targetBranch, error: e instanceof Error ? e.message : String(e) })
    return targetBranch
  }
}

export async function createWorktree(
  projectPath: string,
  prompt: string,
  baseBranch?: string,
  options: CreateWorktreeOptions = {},
): Promise<GitCheckout> {
  const startedAt = Date.now()
  throwIfAborted(options.signal)
  const targetBranchStartedAt = Date.now()
  const targetBranch = baseBranch || await getDefaultBranch(projectPath)
  const targetBranchMs = Date.now() - targetBranchStartedAt
  throwIfAborted(options.signal)
  const startPointStartedAt = Date.now()
  const startPoint = await resolveWorktreeStartPoint(projectPath, targetBranch, options.signal)
  const startPointMs = Date.now() - startPointStartedAt
  const branch = branchFromSlug(slugifyBranch(prompt))
  const worktreePath = path.join(projectPath, SOLUS_WORKTREE_DIR, branch.replace(/\//g, '-'))

  log.info('worktree_creating', { branch, worktreePath, startPoint })
  const checkoutStartedAt = Date.now()
  await runAsync(
    'git',
    ['worktree', 'add', '-b', branch, worktreePath, startPoint],
    projectPath,
    { signal: options.signal },
  )
  const checkoutMs = Date.now() - checkoutStartedAt
  const copyStartedAt = Date.now()
  await copyIncludedWorktreeFiles(projectPath, worktreePath, options.signal)
  const copyMs = Date.now() - copyStartedAt

  log.info('worktree_create_completed', {
    branch,
    worktreePath,
    targetBranchMs,
    startPointMs,
    checkoutMs,
    copyMs,
    totalMs: Date.now() - startedAt,
  })

  return { branch, targetBranch, worktreePath, repoRoot: projectPath }
}

async function copyIncludedWorktreeFiles(
  projectPath: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  const includePath = path.join(projectPath, '.worktreeinclude')
  if (!existsSync(includePath)) return

  const ignoredFiles = (await runAsync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], projectPath, { signal }))
    .split('\0')
    .filter(Boolean)
  if (ignoredFiles.length === 0) return

  const ignoredFileSet = new Set(ignoredFiles)
  const matchedFiles = (await runAsync('git', ['ls-files', '--others', '--ignored', `--exclude-from=${includePath}`, '-z'], projectPath, { signal }))
    .split('\0')
    .filter((relativePath) => relativePath && ignoredFileSet.has(relativePath))

  for (const relativePath of matchedFiles) {
    throwIfAborted(signal)
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
}

export interface CreatePROptions {
  /** Token supplied only to `gh pr create`; git push uses its credential helper. */
  githubToken?: string | null
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
  options: CreatePROptions = {},
): Promise<WorktreePRResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    const branch = gitContext.branch
    if (!branch) return { success: false, error: 'Cannot create a pull request from detached HEAD' }
    const existingUrl = await queryExistingPR(branch, cwd, options.githubToken)
    if (existingUrl) return { success: true, url: existingUrl }

    await commitPendingChanges(cwd, 'chore: apply agent changes')

    await runAsync('git', ['push', '-u', 'origin', branch], cwd)

    const ghOptions = { env: options.githubToken ? { GH_TOKEN: options.githubToken } : undefined }
    const result = await runAsync('gh', [
      'pr', 'create',
      '--base', gitContext.targetBranch,
      '--head', branch,
      '--fill',
    ], cwd, ghOptions)

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

/** Commit without publishing — the spec's default commit action, with push
 *  demoted to a variant beside it. Shares `commitPendingChanges` with
 *  `commitAndPushChanges`, so both write the same generated message. */
export async function commitChanges(
  gitContext: GitCheckout,
  workingDirectory: string,
  options: CommitMessageOptions = {},
): Promise<GitCommitResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    const committed = await commitPendingChanges(cwd, 'chore: apply agent changes', options)
    return { success: true, outcome: committed ? 'committed' : 'unchanged', committed }
  } catch (e: any) {
    return { success: false, outcome: 'failed', committed: false, error: String(e.message || e) }
  }
}

/** Throw away everything uncommitted: tracked files back to HEAD, untracked
 *  files removed. `clean` stays off `-x` so ignored build output and installed
 *  dependencies survive — this discards work, not the checkout. */
export async function discardChanges(
  gitContext: GitCheckout,
  workingDirectory: string,
): Promise<GitDiscardResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    const status = await runAsync('git', ['status', '--porcelain'], cwd)
    const discarded = status ? status.split('\n').filter(Boolean).length : 0
    if (discarded === 0) return { success: true, discarded: 0 }
    await runAsync('git', ['reset', '--hard', 'HEAD'], cwd)
    await runAsync('git', ['clean', '-fd'], cwd)
    log.info('uncommitted_changes_discarded', { discarded, cwd })
    return { success: true, discarded }
  } catch (e: any) {
    return { success: false, discarded: 0, error: String(e.message || e) }
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
      log.info('worktree_synced_with_origin', { targetBranch: gitContext.targetBranch })
    } else {
      await runAsync('git', ['pull', '--no-edit'], cwd)
      log.info('checkout_synced_with_origin', { branch: gitContext.branch })
    }

    return { success: true, outcome: 'synced' }
  } catch (e: any) {
    const conflicted = await runAsync('git', ['diff', '--name-only', '--diff-filter=U'], cwd).catch(() => '')
    return { success: false, outcome: conflicted ? 'conflicted' : 'failed', error: String(e.message || e) }
  }
}

const EXISTING_PR_TTL_MS = 60_000
const existingPrCache = new Map<string, { at: number; url: Promise<string | null> }>()

async function queryExistingPR(branch: string, cwd: string, githubToken?: string | null): Promise<string | null> {
  try {
    const result = await runAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'url', '--jq', '.url'],
      cwd,
      {
        timeout: 10_000,
        env: githubToken ? { GH_TOKEN: githubToken } : undefined,
      },
    )
    return result || null
  } catch {
    return null
  }
}

/** `gh pr view` is a network call used by detailed status consumers. TTL-cache
 *  the result per (cwd, branch) for both hits and misses, and share the in-flight
 *  promise so multiple visible clients collapse to a single spawn. */
export function getExistingPR(branch: string, cwd: string, bypassCache = false): Promise<string | null> {
  const key = `${cwd}\0${branch}`
  if (bypassCache) existingPrCache.delete(key)
  const cached = existingPrCache.get(key)
  if (cached && Date.now() - cached.at < EXISTING_PR_TTL_MS) return cached.url
  const url = queryExistingPR(branch, cwd)
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
    log.info('worktree_restored', { branch, worktreePath })
    return { branch, targetBranch, worktreePath, repoRoot: projectPath }
  } catch (e) {
    log.error('worktree_restore_failed', { worktreePath, error: e instanceof Error ? e.message : String(e) })
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
  /** Whether an existing deterministic PR checkout supplied the result. */
  reused: boolean
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
  // A previous or concurrent open may have already created the checkout without
  // it appearing in `git worktree list` yet. The PR path is deterministic, so an
  // existing directory is already the requested outcome; do not fail by trying
  // to add the same worktree again.
  const existingWorktreePath = existing?.path ?? (existsSync(worktreePath) ? worktreePath : null)
  if (existingWorktreePath) {
    log.info('pr_worktree_reused', { branch, worktreePath: existingWorktreePath })
    // Only a clean checkout is reusable. Never merge through dirty or locally
    // advanced agent work and never claim that an older checkout is current.
    const status = await runAsync('git', ['status', '--porcelain'], existingWorktreePath)
    if (status) {
      throw new Error(`The existing checkout for PR #${prNumber} has local changes. They were left untouched.`)
    }
    await runAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], existingWorktreePath).catch(() => {})
  } else {
    log.info('pr_worktree_creating', { branch, worktreePath })
    const branchExists = await runAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], projectPath).then(
      () => true,
      () => false,
    )
    try {
      if (branchExists) {
        await runAsync('git', ['worktree', 'add', worktreePath, branch], projectPath)
        await runAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], worktreePath).catch(() => {})
      } else {
        await runAsync('git', ['worktree', 'add', '-b', branch, worktreePath, 'FETCH_HEAD'], projectPath)
      }
    } catch (error) {
      // Another open can win between the existence check and `worktree add`.
      // Once the deterministic path exists, creation has reached the desired state.
      if (!existsSync(worktreePath)) throw error
    }
    await copyIncludedWorktreeFiles(projectPath, worktreePath)
  }

  const resolvedWorktreePath = existingWorktreePath ?? worktreePath
  const checkedOutHead = await runAsync('git', ['rev-parse', 'HEAD'], resolvedWorktreePath)
  if (checkedOutHead !== headSha) {
    throw new Error(`The existing checkout for PR #${prNumber} has local commits. They were left untouched.`)
  }

  // Ensure the base ref is present locally, then anchor the diff at the divergence point.
  await runAsync('git', ['fetch', 'origin', baseRef], projectPath).catch(() => {})
  const baseSha = await runAsync('git', ['merge-base', headSha, `origin/${baseRef}`], projectPath).catch(
    () => headSha,
  )

  return { worktreePath: resolvedWorktreePath, branch, baseSha, headSha, reused: !!existingWorktreePath }
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
