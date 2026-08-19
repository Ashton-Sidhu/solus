/**
 * Path math for the typed-path directory picker.
 *
 * `~` is deliberately left unexpanded — the typed path travels to whichever
 * host is being browsed, and that host expands `~` to *its own* home.
 */

export type BrowsePathPlatform = 'posix' | 'win32'

export function browsePathPlatform(platform?: string | null, path?: string): BrowsePathPlatform {
  if (platform) return platform === 'win32' ? 'win32' : 'posix'
  if (!!path && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path)) return 'win32'
  return 'posix'
}

function separatorFor(platform: BrowsePathPlatform): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/'
}

function separatorPattern(platform: BrowsePathPlatform): RegExp {
  return platform === 'win32' ? /[\\/]/ : /\//
}

function trailingSeparatorPattern(platform: BrowsePathPlatform): RegExp {
  return platform === 'win32' ? /[\\/]$/ : /\/$/
}

function canonicalizeSeparators(value: string, platform: BrowsePathPlatform): string {
  return platform === 'win32' ? value.replace(/\//g, '\\') : value
}

/** A trailing separator means the cursor sits at a directory boundary, not inside a name. */
export function hasTrailingSeparator(value: string, platform: BrowsePathPlatform = 'posix'): boolean {
  return trailingSeparatorPattern(platform).test(value)
}

/** Trims and drops trailing separators, keeping a filesystem root intact. */
export function normalizeBrowsePath(value: string, platform: BrowsePathPlatform = 'posix'): string {
  const trimmed = canonicalizeSeparators(value.trim(), platform)
  const anchored = splitAnchoredPath(trimmed, platform)
  if (anchored && anchored.segments.length === 0) {
    return anchored.root.startsWith('~') ? '~' : anchored.root
  }

  const stripped = platform === 'win32'
    ? trimmed.replace(/[\\/]+$/, '')
    : trimmed.replace(/\/+$/, '')
  return stripped || trimmed
}

/** The directory the typed path is listing: "~/dev/so" -> "~/dev/", "~/dev/" -> "~/dev/". */
export function browseDirectoryPath(value: string, platform: BrowsePathPlatform = 'posix'): string {
  const canonical = canonicalizeSeparators(value, platform)
  if (hasTrailingSeparator(canonical, platform)) return canonical
  const separators = [...canonical.matchAll(new RegExp(separatorPattern(platform).source, 'g'))]
  const lastSeparator = separators.at(-1)?.index ?? -1
  return lastSeparator < 0 ? canonical : canonical.slice(0, lastSeparator + 1)
}

/** The partial name being filtered on: "~/dev/so" -> "so", "~/dev/" -> "". */
export function browseLeafSegment(value: string, platform: BrowsePathPlatform = 'posix'): string {
  const canonical = canonicalizeSeparators(value, platform)
  const segments = canonical.split(separatorPattern(platform))
  return segments.at(-1) ?? ''
}

/** Splits an absolute or home-anchored path into its root and segments. */
function splitAnchoredPath(
  value: string,
  platform: BrowsePathPlatform,
): { root: string; segments: string[] } | null {
  const separator = separatorFor(platform)
  const canonical = canonicalizeSeparators(value, platform)

  if (canonical === '~' || canonical.startsWith(`~${separator}`)) {
    return {
      root: `~${separator}`,
      segments: canonical.slice(2).split(separatorPattern(platform)).filter(Boolean),
    }
  }

  if (platform === 'win32') {
    const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(canonical)
    if (unc) {
      const root = `\\\\${unc[1]}\\${unc[2]}\\`
      return {
        root,
        segments: canonical.slice(unc[0].length).split(/\\+/).filter(Boolean),
      }
    }
    const drive = /^([a-zA-Z]:)(?:\\|$)/.exec(canonical)
    if (drive) {
      const root = `${drive[1]}\\`
      return {
        root,
        segments: canonical.slice(drive[0].length).split(/\\+/).filter(Boolean),
      }
    }
    if (canonical.startsWith('\\')) {
      return { root: '\\', segments: canonical.slice(1).split(/\\+/).filter(Boolean) }
    }
    return null
  }

  if (canonical.startsWith('/')) {
    return { root: '/', segments: canonical.slice(1).split(/\/+/).filter(Boolean) }
  }
  return null
}

/** One level up, always directory-shaped. Null at a root. */
export function browseParentPath(
  value: string,
  platform: BrowsePathPlatform = 'posix',
): string | null {
  const normalized = normalizeBrowsePath(value, platform)
  const anchored = splitAnchoredPath(normalized, platform)
  const separator = separatorFor(platform)
  if (anchored) {
    if (anchored.segments.length === 0) return null
    const parent = anchored.segments.slice(0, -1).join(separator)
    return parent ? `${anchored.root}${parent}${separator}` : anchored.root
  }

  const separators = [...normalized.matchAll(new RegExp(separatorPattern(platform).source, 'g'))]
  const lastSeparator = separators.at(-1)?.index ?? -1
  return lastSeparator < 0 ? null : normalized.slice(0, lastSeparator + 1)
}

export interface PathCrumb {
  /** Segment name, or the root itself. */
  label: string
  /** Where clicking the crumb navigates — always directory-shaped. */
  path: string
}

/**
 * The clickable trail for the directory part of a typed path. The leaf being
 * typed is deliberately left out: it is still a filter, not a place.
 */
export function breadcrumbTrail(
  value: string,
  platform: BrowsePathPlatform = 'posix',
): PathCrumb[] {
  const directory = normalizeBrowsePath(browseDirectoryPath(value, platform), platform)
  const anchored = splitAnchoredPath(directory, platform)
  const separator = separatorFor(platform)
  const segments = anchored
    ? anchored.segments
    : directory.split(separatorPattern(platform)).filter(Boolean)

  let prefix = anchored?.root ?? ''
  const rootLabel = prefix.startsWith('~')
    ? '~'
    : prefix.endsWith(separator) && prefix.length > 1
      ? prefix.slice(0, -1)
      : prefix
  const crumbs: PathCrumb[] = anchored ? [{ label: rootLabel, path: prefix }] : []
  for (const segment of segments) {
    prefix = `${prefix}${segment}${separator}`
    crumbs.push({ label: segment, path: prefix })
  }
  return crumbs
}

/**
 * A typed value carrying its own root — pasting one replaces the trail instead
 * of extending the folder currently being browsed.
 */
export function isRootedPath(value: string, platform: BrowsePathPlatform = 'posix'): boolean {
  return splitAnchoredPath(value.trim(), platform) !== null
}

/** Descending into a folder always lands on a directory boundary. */
export function appendPathSegment(
  currentPath: string,
  segment: string,
  platform: BrowsePathPlatform = 'posix',
): string {
  return `${browseDirectoryPath(currentPath, platform)}${segment}${separatorFor(platform)}`
}

/** Joins a host-resolved directory and a leaf without assuming its separator. */
export function joinBrowsePath(
  directory: string,
  segment: string,
  platform: BrowsePathPlatform = 'posix',
): string {
  const separator = separatorFor(platform)
  const base = directory.replace(
    platform === 'win32' ? /[\\/]+$/ : /\/+$/,
    '',
  )
  return `${base}${separator}${segment}`
}

/** Makes a seed path list its own contents rather than filter its parent. */
export function ensureDirectoryPath(
  value: string,
  platform: BrowsePathPlatform = 'posix',
): string {
  const trimmed = canonicalizeSeparators(value.trim(), platform)
  if (trimmed.length === 0 || hasTrailingSeparator(trimmed, platform)) return trimmed
  return `${trimmed}${separatorFor(platform)}`
}

/** Up-navigation is only offered once the user has entered a directory. */
export function canNavigateUp(
  value: string,
  platform: BrowsePathPlatform = 'posix',
): boolean {
  return hasTrailingSeparator(value, platform) && browseParentPath(value, platform) !== null
}

function isExplicitRelativePath(value: string, platform: BrowsePathPlatform): boolean {
  const canonical = canonicalizeSeparators(value, platform)
  const separator = separatorFor(platform)
  return canonical === '.'
    || canonical === '..'
    || canonical.startsWith(`.${separator}`)
    || canonical.startsWith(`..${separator}`)
}

/** Resolves explicit relative paths against the tab cwd; everything else just normalizes. */
export function resolveRelativePath(
  value: string,
  cwd?: string | null,
  platform: BrowsePathPlatform = 'posix',
): string {
  const trimmed = canonicalizeSeparators(value.trim(), platform)
  if (!isExplicitRelativePath(trimmed, platform) || !cwd) {
    return normalizeBrowsePath(trimmed, platform)
  }

  const base = splitAnchoredPath(normalizeBrowsePath(cwd, platform), platform)
  if (!base) return normalizeBrowsePath(trimmed, platform)

  const segments = [...base.segments]
  for (const segment of trimmed.split(separatorPattern(platform))) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  if (segments.length === 0) return normalizeBrowsePath(base.root, platform)
  return `${base.root}${segments.join(separatorFor(platform))}`
}

/** The name shown on the commit button: the last non-empty segment. */
export function inferFolderName(
  value: string,
  platform: BrowsePathPlatform = 'posix',
): string {
  const normalized = normalizeBrowsePath(value, platform)
  return normalized.split(separatorPattern(platform)).filter(Boolean).pop() ?? normalized
}
