import { isAbsolute, join } from 'path'
import { getFinder } from '../../file-finder'

/**
 * The project-relative path a request names, or null when it is not a partial
 * path: an absolute or `~` path already says where it lives, and a `..` path
 * points out of the project on purpose.
 */
export function requestedRelativePath(raw: string): string | null {
  if (!raw || isAbsolute(raw) || raw.startsWith('~')) return null
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) return null
  return normalized
}

/**
 * Complete a partial path against the project's file index.
 *
 * An agent writes the path it was reading, which is often only the end of the
 * real one — `lib/paths.ts` for `packages/workspace-ui/src/lib/paths.ts`. The
 * glob matches whole path segments only, so `sublib/paths.ts` is not a
 * candidate. Two matches mean nobody can say which file was meant, and opening
 * either silently is worse than the miss the caller already has.
 *
 * `root` must already be canonical; the result is absolute.
 */
export async function resolveProjectPathBySuffix(
  root: string,
  requestedPath: string,
): Promise<string | null> {
  const target = requestedRelativePath(requestedPath)
  if (!target) return null

  const finder = await getFinder(root)
  if (!finder) return null

  // A route segment such as `[id]` is a literal name, not glob syntax. The
  // target's own backslashes are already separators, so each one added here
  // is an escape.
  const literal = target.replace(/[*?[\]{}()!]/g, '\\$&')
  const result = finder.glob(`**/${literal}`, { pageSize: 1 })
  if (!result.ok || result.value.totalMatched !== 1) return null
  return join(root, result.value.items[0].relativePath)
}
