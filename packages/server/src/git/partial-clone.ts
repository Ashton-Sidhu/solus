import { runAsync } from './exec'

/**
 * How Solus clones a repository it owns (a Run-on dispatch checkout, a managed
 * pull-request review): every branch with its full commit history, and file
 * contents fetched when a checkout or a diff first needs them. History is never
 * cut, so every merge base exists; an old diff can fetch over the network, so
 * every git command acts as someone (plans/019-acting-identity.md). An origin
 * that does not filter answers with a full clone, which is also correct.
 */
export const PARTIAL_CLONE_ARGS = ['--filter=blob:none'] as const

/**
 * Give a checkout that an earlier version cloned with `--depth=1` its full
 * commit history, once. The fetch is partial like a new clone, and only adds
 * objects: files, local commits, HEAD, and linked worktrees stay as they are.
 */
export async function ensureFullHistory(checkoutPath: string): Promise<void> {
  if (await runAsync('git', ['rev-parse', '--is-shallow-repository'], checkoutPath) !== 'true') return
  try {
    await runAsync('git', ['fetch', '--unshallow', ...PARTIAL_CLONE_ARGS, 'origin'], checkoutPath, { timeout: 10 * 60_000 })
  } catch (error) {
    throw new Error(`Could not fetch the full history of this checkout. Try again. ${error instanceof Error ? error.message : String(error)}`)
  }
}
