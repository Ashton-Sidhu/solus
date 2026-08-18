/** Filenames a project may keep its own mark under, in the order we prefer. */
const FAVICON_FILENAMES = [
  'favicon.ico',
  'favicon.svg',
  'favicon.png',
  'favicon.webp',
  'favicon.jpg',
  'favicon.jpeg',
]

/**
 * What each project root resolved to, remembered for the session.
 *
 * The sidebar mounts one of these marks per rail chip and per group header and
 * re-mounts them on every re-sort, so probing the disk again each time is what
 * makes the fallback flash before the real icon lands. `null` — "this project
 * has no favicon" — is as worth remembering as a hit, because it is the answer
 * that costs six misses to establish.
 */
const resolvedByRoot = new Map<string, string | null>()

const PROJECT_FALLBACK_COLORS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
] as const

export function faviconCandidates(projectRoot: string): string[] {
  const root = projectRoot.replace(/\/+$/, '')
  return FAVICON_FILENAMES.map(
    (name) => `solus-artifact://local/?p=${encodeURIComponent(`${root}/${name}`)}&optional=1`,
  )
}

/** The project's mark, `null` when it has none, `undefined` while unprobed. */
export function resolvedFavicon(projectRoot: string): string | null | undefined {
  return resolvedByRoot.get(projectRoot)
}

export function rememberFavicon(projectRoot: string, url: string | null): void {
  resolvedByRoot.set(projectRoot, url)
}

/** A stable fallback colour for projects that do not provide their own mark.
 *  Returned ready to use as a CSS value — the bare custom-property name is not
 *  a colour, and every caller feeds this straight into a paint. */
export function projectFallbackColor(projectRoot: string): string {
  let hash = 0
  for (let index = 0; index < projectRoot.length; index++) {
    hash = (hash * 31 + projectRoot.charCodeAt(index)) | 0
  }
  return `var(${PROJECT_FALLBACK_COLORS[Math.abs(hash) % PROJECT_FALLBACK_COLORS.length]})`
}
