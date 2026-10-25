/**
 * A path as a host names it (docs/plans/windows.md §5.4). A host is POSIX or
 * Windows, and a client reads paths from either. On Windows `\` and `/` both
 * separate and case does not matter, and Git for Windows prints `C:/x` where
 * Node prints `C:\x`. Every split, prefix test, compare, and name taken from a
 * host path goes through here, never through a `'/'` written at the call site
 * (`solus/host-path-separators`). A server's own path work on its own paths
 * uses `node:path`; this module is for strings whose host may be another
 * machine, and for compares of two spellings of one path.
 */

const SEPARATORS = /[\\/]+/
const TRAILING_SEPARATORS = /[\\/]+$/
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/

/** A drive path (`C:\x`, `c:/x`) or a UNC path (`\\server\share`). */
export function isWindowsHostPath(path: string): boolean {
  return DRIVE.test(path) || path.startsWith('\\\\')
}

/** A path from a root: `/x` on POSIX, a drive or UNC path on Windows. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || isWindowsHostPath(path)
}

/** The path without trailing separators. A root (`/`, `C:\`) keeps its own. */
export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(TRAILING_SEPARATORS, '')
  if (!trimmed) return path.slice(0, 1)
  return /^[A-Za-z]:$/.test(trimmed) && path.length > 2 ? path.slice(0, 3) : trimmed
}

/** The names in a path, in order: `C:\a\b` and `C:/a/b` are `['C:', 'a', 'b']`. */
export function hostPathSegments(path: string): string[] {
  return path.split(SEPARATORS).filter(Boolean)
}

/** The last name in a path: its file or folder name. Empty for a root. */
export function hostPathBaseName(path: string): string {
  const segments = hostPathSegments(path)
  if (segments.length === 1 && isWindowsHostPath(path)) return ''
  return segments.at(-1) ?? ''
}

/**
 * One spelling for every spelling of a path: `/` separators, no trailing one,
 * and lowercase on Windows. Equal keys name the same place. Same length as the
 * trimmed path, so an index into the key is an index into it.
 */
export function hostPathKey(path: string): string {
  const slashed = trimTrailingSeparators(path).replaceAll('\\', '/')
  return isWindowsHostPath(path) ? slashed.toLowerCase() : slashed
}

/** Whether two spellings name one path: `C:\code\x` and `c:/code/x/` do. */
export function sameHostPath(a: string, b: string): boolean {
  return hostPathKey(a) === hostPathKey(b)
}

/**
 * `path` from `root` with `/` separators, as git and every Solus wire format
 * name a project file: `''` for the root itself, null outside it.
 * `C:\code` and `C:\code\src\a.ts` give `src/a.ts`. An absolute path keeps
 * its host's form; only a relative one is written with `/`.
 */
export function relativeHostPath(root: string, path: string): string | null {
  const rootKey = hostPathKey(root)
  const key = hostPathKey(path)
  if (key === rootKey) return ''
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
  if (!key.startsWith(prefix)) return null
  return trimTrailingSeparators(path).slice(prefix.length).replaceAll('\\', '/')
}

/** Whether `path` is `root` or below it. */
export function isInsideHostPath(root: string, path: string): boolean {
  return relativeHostPath(root, path) !== null
}

/** The separator a host path uses: `\` for a Windows path, else `/`. */
export function hostPathSeparator(path: string): '/' | '\\' {
  return isWindowsHostPath(path) ? '\\' : '/'
}

/**
 * `name` below `directory`, in the directory's own separator. A path that
 * cannot say which host it is from (`~`) takes the host's `platform`. A name
 * may hold `/`, as a git path does.
 */
export function joinHostPath(directory: string, name: string, platform?: string | null): string {
  const separator = platform ? (platform === 'win32' ? '\\' : '/') : hostPathSeparator(directory)
  const base = trimTrailingSeparators(directory)
  const tail = name.replace(/^[\\/]+/, '').split(/[\\/]/).join(separator)
  return base.endsWith(separator) ? `${base}${tail}` : `${base}${separator}${tail}`
}
