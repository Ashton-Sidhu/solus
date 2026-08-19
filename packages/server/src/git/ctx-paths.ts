import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { resolveRepoRoot } from './git-helpers'

/**
 * Resolving a context's project scope to a repository root. These lived as
 * `repoRootForCtx`, `repoRootForContext`, and `repoRootFor` in three handler
 * files — names one character apart, behaviours that were not: null, the scope
 * unchanged, or a throw. Naming the answer is the point.
 */

/** `''` and `'~'` are both "no directory", never a path to resolve. */
function usableScope(ctx: IpcContext): string | null {
  const scope = projectScopeOf(ctx.session)
  return scope && scope !== '~' ? scope : null
}

export async function repoRootOrNull(ctx: IpcContext): Promise<string | null> {
  const scope = usableScope(ctx)
  return scope ? resolveRepoRoot(scope) : null
}

/** Falls back to the scope itself, for callers that just need somewhere to read
 *  or write artifacts and don't care whether git is involved. */
export async function repoRootOrScope(ctx: IpcContext): Promise<string> {
  return (await repoRootOrNull(ctx)) ?? projectScopeOf(ctx.session)
}

/** Throws `reason`, for features that are meaningless outside a repository. */
export async function requireRepoRoot(ctx: IpcContext, reason: string): Promise<string> {
  const root = await repoRootOrNull(ctx)
  if (!root) throw new Error(reason)
  return root
}
