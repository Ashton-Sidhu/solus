import { mkdtemp, rm } from 'fs/promises'
import { realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GitCheckout, TurnSnapshot } from '@solus/contracts/types'
import { runAsync } from './exec'
import { createRestoredSessionWorktree, getWorkingBranch, listProjectWorktrees } from './worktree-manager'
import { snapshotLiveTree, writeRestoredSessionSnapshots } from './session-snapshots'

export type CodeRestoreStep = 'fetch' | 'worktree' | 'restore' | 'check'

export class CodeRestoreError extends Error {
  constructor(readonly code: 'missing-prerequisite' | 'tree-mismatch' | 'invalid-input', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodeRestoreError'
  }
}

export interface RestoreSessionCodeInput {
  projectRoot: string
  sessionId: string
  bundleFiles: string[]
  baseSha: string
  snapshots: TurnSnapshot[]
  branch: string
  headSha: string
  ownsWorktree: boolean
  sessionPaths: string[]
  previousWorktree?: { path: string; treeSha: string }
  signal?: AbortSignal
  onProgress?: (step: CodeRestoreStep) => void
}

export interface RestoredSessionCode {
  worktreePath: string
  checkout: GitCheckout
  treeSha: string
  fetchedBundles: number
  reusedWorktree: boolean
}

async function applyTree(worktreePath: string, headSha: string, treeSha: string, patchFile: string, signal?: AbortSignal): Promise<void> {
  await runAsync('git', ['reset', '--hard', headSha], worktreePath, { signal })
  await runAsync('git', ['clean', '-fd'], worktreePath, { signal })
  if (await runAsync('git', ['rev-parse', `${headSha}^{tree}`], worktreePath, { signal }) === treeSha) return
  await runAsync('git', ['diff', '--binary', `--output=${patchFile}`, headSha, treeSha], worktreePath, { signal })
  await runAsync('git', ['apply', patchFile], worktreePath, { signal })
}

/** Restore code objects and a checked checkout from portable turn facts. */
// This operation coordinates four independent steps and their cleanup.
// eslint-disable-next-line complexity
export async function restoreSessionCode(input: RestoreSessionCodeInput): Promise<RestoredSessionCode> {
  const { projectRoot, sessionId, signal } = input
  if (!sessionId || !input.branch || !input.headSha || !input.baseSha) {
    throw new CodeRestoreError('invalid-input', 'The session needs a base commit, branch, and branch tip')
  }
  signal?.throwIfAborted()
  const scratch = await mkdtemp(join(tmpdir(), 'solus-code-restore-'))
  let checkout: GitCheckout | undefined
  let madeWorktree = false
  let previousHead: string | undefined
  let previousTree: string | undefined
  let fetchedBundles = 0
  try {
    input.onProgress?.('fetch')
    for (const bundleFile of input.bundleFiles) {
      signal?.throwIfAborted()
      const heads = (await runAsync('git', ['bundle', 'list-heads', bundleFile], projectRoot, { signal })).split('\n').filter(Boolean)
      const absent = await Promise.all(heads.map(async (line) => {
        const sha = line.split(' ')[0]
        return sha && !(await runAsync('git', ['cat-file', '-e', `${sha}^{object}`], projectRoot, { signal }).then(() => true, () => false))
      }))
      if (!absent.some(Boolean)) continue
      try {
        await runAsync('git', ['bundle', 'verify', bundleFile], projectRoot, { signal })
      } catch (error) {
        signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        const missing = message.match(/\b[0-9a-f]{40,64}\b/g)?.join(', ') ?? input.baseSha
        throw new CodeRestoreError('missing-prerequisite', `Code bundle needs commits absent from this host: ${missing}`, { cause: error })
      }
      await runAsync('git', ['fetch', bundleFile, `refs/solus/sessions/${sessionId}/bundle/*:refs/solus/sessions/${sessionId}/bundle/*`], projectRoot, { signal })
      fetchedBundles++
    }
    for (const sha of [input.baseSha, input.headSha, ...input.snapshots.map(snapshot => snapshot.sha)]) {
      if (!(await runAsync('git', ['cat-file', '-e', `${sha}^{commit}`], projectRoot, { signal }).then(() => true, () => false))) {
        throw new CodeRestoreError('missing-prerequisite', `Code restore needs commit absent from this host: ${sha}`)
      }
    }
    input.onProgress?.('worktree')
    const prior = input.previousWorktree
    const desiredBranch = await getWorkingBranch(projectRoot) === input.branch ? `solus/session-${sessionId}` : input.branch
    const registered = prior && listProjectWorktrees(projectRoot).some(entry => realpathSync(entry.path) === realpathSync(prior.path))
    if (prior && registered && realpathSync(prior.path) !== realpathSync(projectRoot) &&
      await snapshotLiveTree(prior.path, projectRoot) === prior.treeSha &&
      await getWorkingBranch(prior.path) === desiredBranch) {
      previousHead = await runAsync('git', ['rev-parse', 'HEAD'], prior.path, { signal })
      previousTree = prior.treeSha
      checkout = { repoRoot: projectRoot, branch: desiredBranch, targetBranch: desiredBranch, worktreePath: prior.path }
    } else {
      checkout = await createRestoredSessionWorktree(projectRoot, sessionId, input.branch, input.headSha, prior?.path, signal)
      madeWorktree = true
    }
    signal?.throwIfAborted()
    const worktreePath = checkout.worktreePath!
    const lastTree = input.snapshots.at(-1)?.toTreeSha ?? await runAsync('git', ['rev-parse', `${input.baseSha}^{tree}`], projectRoot, { signal })
    let targetTree = lastTree
    if (!input.ownsWorktree) {
      const indexFile = join(scratch, 'index')
      const env = { GIT_INDEX_FILE: indexFile }
      await runAsync('git', ['read-tree', input.baseSha], projectRoot, { env, signal })
      for (const path of input.sessionPaths) {
        if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new CodeRestoreError('invalid-input', `Invalid session path: ${path}`)
        await runAsync('git', ['restore', '--source', lastTree, '--staged', '--', path], projectRoot, { env, signal }).catch(async () => {
          await runAsync('git', ['rm', '--cached', '--ignore-unmatch', '--', path], projectRoot, { env, signal })
        })
      }
      targetTree = await runAsync('git', ['write-tree'], projectRoot, { env, signal })
    }
    input.onProgress?.('restore')
    await applyTree(worktreePath, input.headSha, targetTree, join(scratch, 'restore.patch'), signal)
    input.onProgress?.('check')
    const treeSha = await snapshotLiveTree(worktreePath, projectRoot)
    if (treeSha !== targetTree) throw new CodeRestoreError('tree-mismatch', `Restored tree ${treeSha} differs from expected tree ${targetTree}`)
    signal?.throwIfAborted()
    await writeRestoredSessionSnapshots(projectRoot, sessionId, input.baseSha, input.snapshots, input.sessionPaths, targetTree)
    return { worktreePath, checkout, treeSha, fetchedBundles, reusedWorktree: !madeWorktree }
  } catch (error) {
    if (madeWorktree && checkout?.worktreePath) await runAsync('git', ['worktree', 'remove', '--force', checkout.worktreePath], projectRoot).catch(() => {})
    if (!madeWorktree && checkout?.worktreePath && previousHead && previousTree) {
      await applyTree(checkout.worktreePath, previousHead, previousTree, join(scratch, 'rollback.patch')).catch(() => {})
    }
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
