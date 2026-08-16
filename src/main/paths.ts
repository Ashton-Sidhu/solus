import { isAbsolute, relative, resolve, sep } from 'path'

/**
 * True when `target` is `root` itself or resolves to somewhere beneath it.
 *
 * Containment is decided by `resolve` + `relative` rather than by inspecting the
 * string, so `.`, `..`, doubled separators, drive letters and the platform's own
 * separator are all judged by the platform's rules. A check written against a
 * hardcoded `'../'` silently passes an escaping path on Windows, where
 * `relative()` answers `..\escape` — this is the reason the predicate lives in
 * one place instead of being written per call site.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const fromRoot = relative(resolve(root), resolve(target))
  return fromRoot === ''
    || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

/**
 * Normalize an untrusted, client-supplied path into a root-relative posix path,
 * or throw when it is empty, names the root itself, or escapes the root.
 *
 * Callers hand the result to tools that expect posix separators regardless of
 * platform (a `git` pathspec, for one), so the separator is normalized on the
 * way out rather than at each call site.
 */
export function toRootRelativePath(root: string, raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('A file path cannot be empty.')
  const fromRoot = relative(resolve(root), resolve(root, trimmed))
  if (!fromRoot || !isInsideRoot(root, resolve(root, trimmed))) {
    throw new Error(`File path is outside the repository: ${raw}`)
  }
  return fromRoot.split(sep).join('/')
}
