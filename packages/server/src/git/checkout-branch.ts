import { existsSync, realpathSync } from 'fs'
import { gitOutputPath, runAsync } from './exec'

/** Where work continues after a branch is picked for a project's checkout. */
export type CheckoutBranchChoice =
  /** The checkout at `cwd` was on the branch already, or moved to it. */
  | { kind: 'current' | 'switched'; workingDirectory: string }
  /** Another worktree has the branch: work continues there, and `cwd` stays as it is. */
  | { kind: 'worktree'; workingDirectory: string }
  | { kind: 'refused'; error: string }

/**
 * Put the checkout at `cwd` on `branch`, as T3's current-checkout branch
 * picker does. The list the person picked from can be stale, so Git is read
 * again first:
 * - the checkout is on the branch already: nothing changes;
 * - another worktree has the branch: that worktree is the answer, but only
 *   when `cwd` is its checkout's root, because a subfolder has no matching
 *   place in the other worktree;
 * - a branch on a remote only becomes a local branch that tracks it. With
 *   `remoteOnly` (the person picked the remote branch), a local branch of the
 *   same name must already track that remote branch.
 * Git refuses a switch that would overwrite uncommitted changes; nothing forces it.
 */
export async function checkoutBranch(cwd: string, branch: string, options: { remoteOnly?: boolean } = {}): Promise<CheckoutBranchChoice> {
  if (!branch || branch.startsWith('-')) return { kind: 'refused', error: `Not a valid branch name: ${branch}` }
  const [heads, remoteRefs, remotes, checkoutRoot] = await Promise.all([
    runAsync('git', ['for-each-ref', '--format=%(refname)%00%(upstream)%00%(worktreepath)', 'refs/heads'], cwd),
    runAsync('git', ['for-each-ref', '--format=%(refname)', 'refs/remotes'], cwd),
    runAsync('git', ['remote'], cwd),
    runAsync('git', ['rev-parse', '--show-toplevel'], cwd).then((output) => gitOutputPath(cwd, output)),
  ])
  const local = heads.split('\n').map((line) => line.split('\0')).find(([ref]) => ref === `refs/heads/${branch}`)
  // Exact refs only: a name never reaches git as a pattern or a guess.
  const remoteRefOf = (remote: string) => `refs/remotes/${remote}/${branch}`
  const remoteNames = remotes.split('\n').filter(Boolean)
  if (local) {
    const [, upstream, worktreePath] = local
    if (options.remoteOnly && !remoteNames.some((remote) => upstream === remoteRefOf(remote))) {
      return { kind: 'refused', error: `A local branch named ${branch} exists and does not track the remote branch. Choose the local branch, or rename it first.` }
    }
    if (worktreePath && samePath(worktreePath, checkoutRoot)) return { kind: 'current', workingDirectory: cwd }
    if (worktreePath) {
      if (!samePath(cwd, checkoutRoot)) {
        return { kind: 'refused', error: `${branch} is checked out in another worktree, and this project is a folder inside its repository. Choose another branch, or add the repository root as a project to work in that worktree.` }
      }
      if (!existsSync(worktreePath)) {
        return { kind: 'refused', error: `${branch} is checked out in a worktree that no longer exists: ${worktreePath}. Run git worktree prune, or choose another branch.` }
      }
      return { kind: 'worktree', workingDirectory: worktreePath }
    }
    await runAsync('git', ['switch', '--no-guess', branch], cwd)
    return { kind: 'switched', workingDirectory: cwd }
  }
  const remoteRefSet = new Set(remoteRefs.split('\n'))
  const tracked = remoteNames.filter((remote) => remoteRefSet.has(remoteRefOf(remote)))
  // Several remotes have the branch: origin is the one git users expect.
  const remote = tracked.length === 1 ? tracked[0] : tracked.find((name) => name === 'origin')
  if (!remote) {
    return { kind: 'refused', error: tracked.length ? `${branch} is on several remotes: ${tracked.join(', ')}.` : `Branch not found: ${branch}` }
  }
  await runAsync('git', ['switch', '--create', branch, '--track', remoteRefOf(remote)], cwd)
  return { kind: 'switched', workingDirectory: cwd }
}

function samePath(a: string, b: string): boolean {
  const real = (path: string) => { try { return realpathSync.native(path) } catch { return path } }
  return real(a) === real(b)
}
