const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || WINDOWS_DRIVE_RE.test(path)
}

/**
 * The path a file chip's tooltip should state.
 *
 * An agent usually writes a link relative to its own working directory, and the
 * chip's label is often that same string — so the tooltip repeats the label and
 * the reader still cannot tell which checkout it means. Resolving against the
 * session's own directory is what makes the answer complete. A path that is
 * already absolute, and a session with no directory, are both left alone.
 */
export function fileLinkTooltip(
  path: string,
  line: number | undefined,
  workingDirectory: string | undefined,
): string {
  const lineSuffix = line ? `:${line}` : ''
  if (isAbsolutePath(path) || !workingDirectory || workingDirectory === '~') {
    return `${path}${lineSuffix}`
  }
  const separator = workingDirectory.includes('\\') && !workingDirectory.includes('/') ? '\\' : '/'
  const base = workingDirectory.replace(/[\\/]+$/, '')
  const relative = path.replace(/^\.\//, '')
  return `${base}${separator}${relative}${lineSuffix}`
}
