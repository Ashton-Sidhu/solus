// Private logic for the Activity overview: shaping GitHub diff hunks for the
// inline thread previews, and the initials shown in author/comment avatars.
// (Per-file +/- counts come from the `prChangedFiles` numstat handler.)

/**
 * Wrap a GitHub `diffHunk` (a bare `@@ … @@` fragment with no file headers) in a
 * minimal `diff --git` envelope so `@pierre/diffs`' patch parser accepts it and
 * renders the snippet with the same engine the Diff tab uses.
 */
export function hunkToPatch(filePath: string, hunk: string): string {
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${hunk}\n`
}

/** Up to two uppercase initials from a display name or login (`ashton-sidhu` → `AS`). */
export function initials(name: string): string {
  const parts = name.split(/[\s_./-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** `foo/bar/baz.ts` → `baz.ts`. */
export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/** Directory portion of a path, with a trailing slash (`foo/bar/baz.ts` → `foo/bar/`). */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i + 1) : ''
}
