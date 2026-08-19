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
